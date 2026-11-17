"""Thin paho-mqtt wrapper with reconnect backoff and Last Will."""

import logging
import time
import uuid

import paho.mqtt.client as mqtt

from config import (
    MQTT_HOST,
    MQTT_PORT,
    MQTT_USERNAME,
    MQTT_PASSWORD,
    TOPIC_REQUESTS,
    TOPIC_RESULTS,
    STATION_ID,
)

log = logging.getLogger(__name__)

# ponytail: single global client, no factory class needed.
_client: mqtt.Client | None = None
_on_message_handler = None  # set by main.py before connect


def _on_connect(client, userdata, flags, rc, properties=None):
    if rc == 0:
        log.info("MQTT connected to %s:%s", MQTT_HOST, MQTT_PORT)
        client.subscribe(TOPIC_REQUESTS, qos=1)
        log.info("Subscribed to %s (QoS 1)", TOPIC_REQUESTS)
    else:
        log.error("MQTT connect failed: rc=%s", rc)


def _on_disconnect(client, userdata, flags, rc, properties=None):
    if rc != 0:
        log.warning("MQTT unexpected disconnect (rc=%s), will auto-reconnect", rc)


def _on_message(client, userdata, msg):
    if _on_message_handler:
        _on_message_handler(msg)


def connect(on_message):
    """Create, configure, and start the MQTT client. Returns the client."""
    global _client, _on_message_handler
    _on_message_handler = on_message

    client_id = f"mlworker-{STATION_ID}-{uuid.uuid4().hex[:8]}"
    _client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=client_id,
        protocol=mqtt.MQTTv311,
    )
    _client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)

    # Last Will: if we crash, broker publishes this so other services know
    _client.will_set(
        f"evdt/v1/stations/{STATION_ID}/status",
        payload='{"mlworker":"offline"}',
        qos=1,
        retain=True,
    )

    _client.on_connect = _on_connect
    _client.on_disconnect = _on_disconnect
    _client.on_message = _on_message

    # Reconnect with exponential backoff (paho v2 built-in)
    _client.reconnect_delay_set(min_delay=1, max_delay=30)

    _client.connect(MQTT_HOST, MQTT_PORT, keepalive=60)
    _client.loop_start()
    return _client


def publish_result(payload_str: str):
    """Publish a JSON result string to the results topic (QoS 1)."""
    if _client is None:
        log.error("Cannot publish: MQTT client not connected")
        return
    info = _client.publish(TOPIC_RESULTS, payload_str, qos=1)
    # ponytail: don't block on info.wait_for_publish(); QoS 1 handles delivery.


def disconnect():
    """Graceful shutdown."""
    if _client:
        _client.loop_stop()
        _client.disconnect()
        log.info("MQTT disconnected")
