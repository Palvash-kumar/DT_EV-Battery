"""Tests for the OPC UA -> MQTT bridge (laptop-2/opcua_bridge/bridge.py).

Run:  cd laptop-2 && python -m pytest tests/test_opcua_bridge.py -v

The integration test starts an in-process OPC UA server with the same node ids
as the sensor laptop's server (laptop-sensor/src/opcuaServer.js).
"""

import asyncio
import socket
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from asyncua import Server, ua

_root = Path(__file__).resolve().parent.parent
if str(_root) not in sys.path:
    sys.path.insert(0, str(_root))

from opcua_bridge.bridge import (  # noqa: E402
    NAMESPACE_URI,
    TelemetryBridge,
    build_message,
    iso_utc,
    load_settings,
    schema_errors,
)

META = {"station_id": "STATION-TEST", "sensor_id": "LM35-A0-01", "source": "sensor", "calibration": "uncalibrated"}


class FakePublisher:
    def __init__(self):
        self.connected = True
        self.messages = []

    def publish(self, message):
        if not self.connected:
            return False
        self.messages.append(dict(message))
        return True


def settings(url="opc.tcp://127.0.0.1:4840/evdt"):
    return load_settings({"OPCUA_URL": url, "MQTT_PASSWORD": "x"})


def good(value, ts):
    return ua.DataValue(Value=ua.Variant(value, ua.VariantType.Double), SourceTimestamp=ts)


def bad(ts):
    return ua.DataValue(
        Value=ua.Variant(31.0, ua.VariantType.Double),
        StatusCode=ua.StatusCode(ua.StatusCodes.BadNoCommunication),
        SourceTimestamp=ts,
    )


# ── settings and message ─────────────────────────────────────────────────────


def test_settings_defaults_and_required():
    s = settings()
    assert (s.mqtt_host, s.mqtt_port, s.mqtt_username) == ("127.0.0.1", 1883, "opcbridge")
    assert s.topic == "evdt/v1/telemetry/temperature"
    assert s.namespace_uri == NAMESPACE_URI
    with pytest.raises(ValueError, match="OPCUA_URL"):
        load_settings({"MQTT_PASSWORD": "x"})
    with pytest.raises(ValueError, match="MQTT_PASSWORD"):
        load_settings({"OPCUA_URL": "opc.tcp://h:4840/evdt"})
    with pytest.raises(ValueError, match="opc.tcp"):
        load_settings({"OPCUA_URL": "http://h:4840", "MQTT_PASSWORD": "x"})


def test_timestamps_are_utc_iso_with_z():
    assert iso_utc(datetime(2026, 11, 18, 12, 0, 1, 250000)) == "2026-11-18T12:00:01.250Z"  # naive = UTC
    ist = timezone(timedelta(hours=5, minutes=30))
    assert iso_utc(datetime(2026, 11, 18, 17, 30, 1, tzinfo=ist)) == "2026-11-18T12:00:01.000Z"


def test_message_matches_shared_telemetry_schema():
    ts = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
    m = build_message(31.256, ts, META)
    assert schema_errors(m) == []
    assert m["source"] == "sensor" and m["simulated"] is False
    assert m["temperatureC"] == 31.26
    assert m["timestamp"] == "2026-11-18T12:00:00.000Z"
    assert schema_errors({**m, "temperatureC": 120}) != []


# ── notification handling ────────────────────────────────────────────────────


def test_good_values_are_published_once_each():
    pub = FakePublisher()
    b = TelemetryBridge(settings(), pub)
    t1 = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
    assert b.handle_data_value(good(31.26, t1), META) == "published"
    assert b.handle_data_value(good(31.26, t1), META) == "duplicate"  # same reading re-sent after reconnect
    assert b.handle_data_value(good(31.26, t1 + timedelta(seconds=5)), META) == "published"  # same number, new reading
    assert [m["timestamp"] for m in pub.messages] == ["2026-11-18T12:00:00.000Z", "2026-11-18T12:00:05.000Z"]


def test_clock_set_back_on_the_sensor_laptop_does_not_block_readings():
    pub = FakePublisher()
    b = TelemetryBridge(settings(), pub)
    t1 = datetime(2026, 11, 18, 12, 0, 0, tzinfo=timezone.utc)
    assert b.handle_data_value(good(30.0, t1), META) == "published"
    assert b.handle_data_value(good(30.0, t1 - timedelta(seconds=20)), META) == "duplicate"  # replay
    assert b.handle_data_value(good(30.1, t1 - timedelta(hours=1)), META) == "published"  # clock reset
    assert b.handle_data_value(good(30.2, t1 - timedelta(hours=1) + timedelta(seconds=5)), META) == "published"


def test_bad_status_is_never_published():
    pub = FakePublisher()
    b = TelemetryBridge(settings(), pub)
    assert b.handle_data_value(bad(datetime.now(timezone.utc)), META) == "bad-status"
    assert pub.messages == []
    assert b.sensor_good is False


def test_refuses_data_not_marked_as_sensor():
    pub = FakePublisher()
    b = TelemetryBridge(settings(), pub)
    assert b.handle_data_value(good(30.0, datetime.now(timezone.utc)), {**META, "source": "simulation"}) == "not-sensor"
    assert pub.messages == []


def test_broker_down_drops_instead_of_queueing():
    pub = FakePublisher()
    pub.connected = False
    b = TelemetryBridge(settings(), pub)
    t1 = datetime.now(timezone.utc)
    assert b.handle_data_value(good(30.0, t1), META) == "broker-down"
    pub.connected = True
    # the dropped reading is not sent later
    assert b.handle_data_value(good(30.0, t1), META) == "duplicate"
    assert pub.messages == []


# ── against a real OPC UA server ─────────────────────────────────────────────


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def start_sensor_server(port, value=None):
    server = Server()
    await server.init()
    server.set_endpoint(f"opc.tcp://127.0.0.1:{port}/evdt")
    server.set_security_policy([ua.SecurityPolicyType.NoSecurity])
    idx = await server.register_namespace(NAMESPACE_URI)
    station = await server.nodes.objects.add_object(ua.NodeId("Station", idx), f"{idx}:EVChargingStation")
    await station.add_variable(ua.NodeId("Station.StationId", idx), f"{idx}:StationId", "STATION-TEST")
    sensor = await station.add_object(ua.NodeId("AmbientSensor", idx), f"{idx}:AmbientSensor")
    temp = await sensor.add_variable(
        ua.NodeId("AmbientSensor.TemperatureC", idx), f"{idx}:TemperatureC", ua.Variant(0.0, ua.VariantType.Double)
    )
    for key, val in (("SensorId", "LM35-A0-01"), ("Source", "sensor"), ("CalibrationStatus", "uncalibrated")):
        await sensor.add_variable(ua.NodeId(f"AmbientSensor.{key}", idx), f"{idx}:{key}", val)
    await temp.write_value(
        value
        or ua.DataValue(
            Value=ua.Variant(0.0, ua.VariantType.Double),
            StatusCode=ua.StatusCode(ua.StatusCodes.BadWaitingForInitialData),
        )
    )
    await server.start()
    return server, temp


async def wait_for(cond, timeout=10.0):
    end = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < end:
        if cond():
            return
        await asyncio.sleep(0.05)
    raise AssertionError("timed out")


def test_end_to_end_with_a_real_opcua_server():
    async def scenario():
        port = free_port()
        server, temp = await start_sensor_server(port)
        pub = FakePublisher()
        bridge = TelemetryBridge(settings(f"opc.tcp://127.0.0.1:{port}/evdt"), pub)
        stop = asyncio.Event()
        task = asyncio.create_task(bridge.run_forever(stop))
        try:
            await wait_for(lambda: bridge.connected_once)
            await asyncio.sleep(0.5)
            assert pub.messages == [], "no value before the first reading"

            t1 = datetime.now(timezone.utc) - timedelta(seconds=2)
            await temp.write_value(good(31.26, t1))
            await wait_for(lambda: len(pub.messages) == 1)
            m = pub.messages[0]
            assert (m["temperatureC"], m["stationId"], m["sensorId"], m["source"]) == (31.26, "STATION-TEST", "LM35-A0-01", "sensor")
            assert m["timestamp"] == iso_utc(t1), "timestamp is the sensor laptop's SourceTimestamp"
            assert schema_errors(m) == []

            t2 = t1 + timedelta(seconds=1)
            await temp.write_value(good(31.26, t2))  # same number, new reading
            await wait_for(lambda: len(pub.messages) == 2)

            await temp.write_value(bad(datetime.now(timezone.utc)))
            await wait_for(lambda: bridge.sensor_good is False)
            await asyncio.sleep(0.5)
            assert len(pub.messages) == 2, "nothing published while the sensor is offline"

            t3 = datetime.now(timezone.utc)
            await temp.write_value(good(31.4, t3))
            await wait_for(lambda: len(pub.messages) == 3)

            # sensor laptop restarts; it comes back still holding the t3 reading
            await server.stop()
            await wait_for(lambda: not bridge.connected_once, timeout=30)
            server, temp = await start_sensor_server(port, good(31.4, t3))
            await wait_for(lambda: bridge.connected_once, timeout=30)
            await asyncio.sleep(1.0)
            assert len(pub.messages) == 3, "the same reading is not published twice after a reconnect"

            t4 = datetime.now(timezone.utc)
            await temp.write_value(good(31.5, t4))
            await wait_for(lambda: len(pub.messages) == 4)
            assert pub.messages[-1]["temperatureC"] == 31.5
        finally:
            stop.set()
            await asyncio.wait_for(task, timeout=20)
            await server.stop()

    asyncio.run(scenario())
