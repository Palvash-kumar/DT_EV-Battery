"""OPC UA -> MQTT bridge (runs on the Mac, next to Mosquitto and the ML worker).

Sensor laptop (OPC UA server, Arduino on USB)  --OPC UA-->  this bridge  --MQTT-->  Mosquitto
  --> web laptop backend (subscribed to evdt/v1/telemetry/temperature).

It subscribes to AmbientSensor.TemperatureC on the sensor laptop and, for each
new Good value, publishes the message defined in
shared/schemas/telemetry-temperature.schema.json with source "sensor". The
timestamp is the OPC UA SourceTimestamp (when the reading arrived at the sensor
laptop), never the time it passed through here.

It publishes NOTHING when the value's status is Bad (sensor offline), when the
OPC UA connection is down or when the broker is down. Old readings are not
queued and replayed. The web laptop then shows "Sensor offline" by itself.

Run (from laptop-2, with the venv active):
    python opcua_bridge/bridge.py
Settings: laptop-2/opcua_bridge/.env (copy .env.example).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

import jsonschema
import paho.mqtt.client as mqtt
from asyncua import Client, ua
from asyncua.common.subscription import DataChangeEvent, StatusChangeEvent
from dotenv import load_dotenv

log = logging.getLogger("opcua_bridge")

NAMESPACE_URI = "urn:evdt:sensor"
# String node ids served by laptop-sensor/src/opcuaServer.js (namespace resolved by URI).
NODE_IDS = {
    "station_id": "Station.StationId",
    "temperature": "AmbientSensor.TemperatureC",
    "sensor_id": "AmbientSensor.SensorId",
    "source": "AmbientSensor.Source",
    "calibration": "AmbientSensor.CalibrationStatus",
}

_SCHEMA_PATH = (
    Path(__file__).resolve().parent.parent.parent / "shared" / "schemas" / "telemetry-temperature.schema.json"
)
with open(_SCHEMA_PATH, encoding="utf-8") as f:
    _VALIDATOR = jsonschema.Draft202012Validator(
        json.load(f), format_checker=jsonschema.Draft202012Validator.FORMAT_CHECKER
    )

# With no notification for this long, the bridge checks the server is still there.
HEALTH_CHECK_SEC = 10.0
# A value up to this much older than the last published one is a replay (e.g. the
# current value re-sent after a reconnect). Much older means the sensor laptop's
# clock was set back: it is published, with a warning. The sensor server never
# keeps a reading Good for more than SENSOR_STALE_SEC (30 s), so a real replay
# is never that old.
REPLAY_WINDOW_SEC = 60.0
MAX_BACKOFF_SEC = 30.0


# ── Settings ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Settings:
    opcua_url: str
    namespace_uri: str
    mqtt_host: str
    mqtt_port: int
    mqtt_username: str
    mqtt_password: str
    topic: str
    max_clock_skew_sec: float
    log_level: str


def load_settings(env: Mapping[str, str]) -> Settings:
    def need(key: str) -> str:
        val = env.get(key, "").strip()
        if not val:
            raise ValueError(f"Missing required setting {key} in laptop-2/opcua_bridge/.env")
        return val

    url = need("OPCUA_URL")
    if not url.startswith("opc.tcp://"):
        raise ValueError(f"OPCUA_URL must start with opc.tcp:// (got {url!r})")
    try:
        port = int(env.get("MQTT_PORT", "1883"))
        skew = float(env.get("MAX_CLOCK_SKEW_SEC", "5"))
    except ValueError as err:
        raise ValueError(f"MQTT_PORT / MAX_CLOCK_SKEW_SEC must be numbers: {err}") from err
    return Settings(
        opcua_url=url,
        namespace_uri=env.get("OPCUA_NAMESPACE_URI", NAMESPACE_URI),
        mqtt_host=env.get("MQTT_HOST", "127.0.0.1"),
        mqtt_port=port,
        mqtt_username=env.get("MQTT_USERNAME", "opcbridge"),
        mqtt_password=need("MQTT_PASSWORD"),
        topic=env.get("MQTT_TOPIC_TELEMETRY_TEMP", "evdt/v1/telemetry/temperature"),
        max_clock_skew_sec=skew,
        log_level=env.get("LOG_LEVEL", "INFO").upper(),
    )


# ── Message building ─────────────────────────────────────────────────────────


def to_utc(ts: datetime) -> datetime:
    """OPC UA timestamps are UTC; asyncua may hand them over without tzinfo."""
    return ts.replace(tzinfo=timezone.utc) if ts.tzinfo is None else ts.astimezone(timezone.utc)


def iso_utc(ts: datetime) -> str:
    return to_utc(ts).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_message(temperature_c: float, source_timestamp: datetime, meta: Mapping[str, str]) -> dict[str, Any]:
    return {
        "schemaVersion": "1.0",
        "messageId": str(uuid.uuid4()),
        "stationId": meta["station_id"],
        "sensorId": meta["sensor_id"],
        "timestamp": iso_utc(source_timestamp),
        "temperatureC": round(float(temperature_c), 2),
        "source": "sensor",
        "calibrationStatus": meta["calibration"],
        "simulated": False,
    }


def schema_errors(message: Mapping[str, Any]) -> list[str]:
    return [
        f"{'.'.join(str(p) for p in e.absolute_path) or '(root)'}: {e.message}"
        for e in _VALIDATOR.iter_errors(message)
    ]


# ── MQTT side ────────────────────────────────────────────────────────────────


class Publisher(Protocol):
    def publish(self, message: Mapping[str, Any]) -> bool: ...


class MqttPublisher:
    """Publishes to Mosquitto. Never queues: returns False while disconnected."""

    def __init__(self, settings: Settings):
        self.topic = settings.topic
        self.where = f"{settings.mqtt_host}:{settings.mqtt_port}"
        self.username = settings.mqtt_username
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=f"opcua-bridge-{uuid.uuid4().hex[:8]}",
        )
        self.client.username_pw_set(settings.mqtt_username, settings.mqtt_password)
        self.client.reconnect_delay_set(min_delay=1, max_delay=30)
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect
        self.client.connect_async(settings.mqtt_host, settings.mqtt_port, keepalive=60)
        self.client.loop_start()

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code.is_failure:
            log.error(
                "MQTT login to %s as %r refused: %s (check MQTT_USERNAME/MQTT_PASSWORD and mosquitto/passwd)",
                self.where, self.username, reason_code,
            )
        else:
            log.info("MQTT connected to %s as %r, publishing to %s", self.where, self.username, self.topic)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        log.warning("MQTT disconnected from %s (%s); readings are NOT published until it is back", self.where, reason_code)

    def publish(self, message: Mapping[str, Any]) -> bool:
        if not self.client.is_connected():
            return False
        info = self.client.publish(self.topic, json.dumps(message), qos=1)
        return info.rc == mqtt.MQTT_ERR_SUCCESS

    def close(self) -> None:
        self.client.loop_stop()
        self.client.disconnect()


# ── OPC UA side ──────────────────────────────────────────────────────────────


class TelemetryBridge:
    def __init__(self, settings: Settings, publisher: Publisher, now: Callable[[], datetime] | None = None):
        self.settings = settings
        self.publisher = publisher
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.last_timestamp: datetime | None = None
        self.sensor_good: bool | None = None
        self.connected_once = False
        self.stats = {"published": 0, "bad_status": 0, "duplicates": 0, "not_published": 0, "invalid": 0}

    # One data-change notification. Returns what happened (used by the tests).
    def handle_data_value(self, dv: ua.DataValue, meta: Mapping[str, str]) -> str:
        status = dv.StatusCode
        if status is not None and not status.is_good():
            self.stats["bad_status"] += 1
            if self.sensor_good is not False:
                log.warning("sensor OFFLINE at the sensor laptop (%s) - nothing is published", status.name)
            self.sensor_good = False
            return "bad-status"

        value = dv.Value.Value if dv.Value is not None else None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            self.stats["invalid"] += 1
            log.error("TemperatureC has no numeric value (%r); skipped", value)
            return "no-value"
        if dv.SourceTimestamp is None:
            self.stats["invalid"] += 1
            log.error("TemperatureC value has no SourceTimestamp; skipped (cannot tell when it was measured)")
            return "no-timestamp"
        if meta.get("source") != "sensor":
            self.stats["invalid"] += 1
            log.error("server says Source=%r, not 'sensor'; refusing to publish it as sensor data", meta.get("source"))
            return "not-sensor"

        ts = to_utc(dv.SourceTimestamp)
        # After a reconnect the server re-sends the current value: don't publish it twice.
        if self.last_timestamp is not None and ts <= self.last_timestamp:
            behind = (self.last_timestamp - ts).total_seconds()
            if behind <= REPLAY_WINDOW_SEC:
                self.stats["duplicates"] += 1
                return "duplicate"
            log.warning("sensor laptop clock went back by %.0f s; publishing the new readings", behind)
        self.last_timestamp = ts

        if self.sensor_good is not True:
            log.info("sensor live at the sensor laptop")
        self.sensor_good = True

        message = build_message(value, ts, meta)
        errors = schema_errors(message)
        if errors:
            self.stats["invalid"] += 1
            log.error("reading does not match telemetry schema, not published: %s", "; ".join(errors))
            return "invalid"
        if not self.publisher.publish(message):
            self.stats["not_published"] += 1
            log.warning("%.2f °C not published: MQTT broker not connected", message["temperatureC"])
            return "broker-down"
        self.stats["published"] += 1
        log.info(
            "%.2f °C  %s  (read %s) -> MQTT %s",
            message["temperatureC"], message["sensorId"], message["timestamp"], self.settings.topic,
        )
        return "published"

    async def check_clock(self, client: Client) -> float:
        """Warn when this Mac's clock and the sensor laptop's clock disagree."""
        server_now = await client.get_node(ua.NodeId(ua.ObjectIds.Server_ServerStatus_CurrentTime)).read_value()
        skew = (self.now() - to_utc(server_now)).total_seconds()
        if abs(skew) > self.settings.max_clock_skew_sec:
            log.warning(
                "clock difference with the sensor laptop is %.1f s (limit %.0f s). Readings carry the sensor "
                "laptop's time, so turn on automatic time sync on all three laptops.",
                skew, self.settings.max_clock_skew_sec,
            )
        else:
            log.info("clock difference with the sensor laptop: %.1f s (ok)", skew)
        return skew

    async def run_session(self, stop: asyncio.Event) -> None:
        """One connection to the OPC UA server; returns or raises when it ends."""
        url = self.settings.opcua_url
        async with Client(url=url, timeout=10) as client:
            try:
                ns = await client.get_namespace_index(self.settings.namespace_uri)
            except ValueError as err:
                raise RuntimeError(
                    f"{url} has no namespace {self.settings.namespace_uri!r}; is it the EVDT sensor server?"
                ) from err

            def node(key: str):
                return client.get_node(ua.NodeId(NODE_IDS[key], ns))

            meta = {k: await node(k).read_value() for k in ("station_id", "sensor_id", "source", "calibration")}
            await self.check_clock(client)

            sub = await client.create_subscription(500, None)  # iterator mode
            params = ua.MonitoringParameters()
            params.ClientHandle = 1
            params.SamplingInterval = 0  # the server pushes each update (exception-based)
            params.QueueSize = 10
            params.DiscardOldest = True
            # Notify on a new timestamp too, so a repeated temperature is still a new reading.
            params.Filter = ua.DataChangeFilter(Trigger=ua.DataChangeTrigger.StatusValueTimestamp)
            item = ua.MonitoredItemCreateRequest()
            item.ItemToMonitor = ua.ReadValueId(NodeId=node("temperature").nodeid, AttributeId=ua.AttributeIds.Value)
            item.MonitoringMode = ua.MonitoringMode.Reporting
            item.RequestedParameters = params
            result = (await sub.create_monitored_items([item]))[0]
            if isinstance(result, ua.StatusCode):
                raise RuntimeError(f"could not subscribe to TemperatureC: {result.name}")

            log.info(
                "OPC UA connected to %s: station %s, sensor %s (%s); subscribed to TemperatureC",
                url, meta["station_id"], meta["sensor_id"], meta["calibration"],
            )
            self.connected_once = True
            while not stop.is_set():
                event = await sub.next_event(timeout=HEALTH_CHECK_SEC)
                if event is None:
                    # Quiet for a while: make sure the server is still there (raises if not).
                    await client.get_node(ua.NodeId(ua.ObjectIds.Server_ServerStatus_State)).read_value()
                    continue
                if isinstance(event, DataChangeEvent):
                    self.handle_data_value(event.data.monitored_item.Value, meta)
                elif isinstance(event, StatusChangeEvent) and not event.notification.Status.is_good():
                    raise RuntimeError(f"subscription closed by the server: {event.notification.Status.name}")

    async def run_forever(self, stop: asyncio.Event) -> None:
        delay = 1.0
        while not stop.is_set():
            self.connected_once = False
            try:
                await self.run_session(stop)
            except asyncio.CancelledError:
                raise
            except Exception as err:  # connection refused, lost, timeout, bad server ...
                if self.sensor_good is not False:
                    log.warning("sensor data unavailable - nothing is published until the OPC UA link is back")
                self.sensor_good = False
                log.warning("OPC UA %s: %s - retrying in %.0f s", self.settings.opcua_url, str(err) or type(err).__name__, delay)
            if stop.is_set():
                break
            delay = 1.0 if self.connected_once else min(delay * 2, MAX_BACKOFF_SEC)
            try:
                await asyncio.wait_for(stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass


# ── Entry point ──────────────────────────────────────────────────────────────


async def _main(settings: Settings) -> None:
    publisher = MqttPublisher(settings)
    bridge = TelemetryBridge(settings, publisher)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):  # Windows: Ctrl+C raises KeyboardInterrupt instead
            pass
    log.info("OPC UA -> MQTT bridge starting: %s -> %s:%s", settings.opcua_url, settings.mqtt_host, settings.mqtt_port)
    try:
        await bridge.run_forever(stop)
    finally:
        log.info("stopping: %s", bridge.stats)
        publisher.close()


def main() -> None:
    load_dotenv(Path(__file__).resolve().parent / ".env")
    try:
        settings = load_settings(os.environ)
    except ValueError as err:
        raise SystemExit(f"[opcua_bridge] {err}") from None
    logging.basicConfig(
        level=getattr(logging, settings.log_level, logging.INFO),
        format="%(asctime)s %(levelname)s [opcua_bridge] %(message)s",
    )
    # asyncua logs every reconnect attempt at length; our own lines say what matters.
    logging.getLogger("asyncua").setLevel(logging.ERROR)
    try:
        asyncio.run(_main(settings))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
