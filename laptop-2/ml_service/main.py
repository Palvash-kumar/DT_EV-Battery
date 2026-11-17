"""ML inference worker entry point.

Loads models once, connects to MQTT, processes charging prediction requests
off the callback thread, and publishes correlated results.
"""

import json
import logging
import signal
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import config
import mqtt_client
import predictors
import schemas

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=getattr(logging, config.LOG_LEVEL, logging.INFO),
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger("ml_worker")

# ── Deduplication ─────────────────────────────────────────────────────────────
# ponytail: in-memory set, no persistence needed for a college prototype.
_seen_message_ids: set[str] = set()
_seen_request_ids: dict[str, str] = {}  # requestId → cached result JSON

# ── Worker pool ───────────────────────────────────────────────────────────────
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="inference")

# ── Health metrics ────────────────────────────────────────────────────────────
_stats = {"processed": 0, "errors": 0, "duplicates": 0, "started_at": None}


def _build_result(request_id: str, status: str, body: dict | None = None,
                  error: dict | None = None) -> str:
    """Build a JSON result string matching charging-result.schema.json."""
    result = {
        "schemaVersion": "1.0",
        "messageId": str(uuid.uuid4()),
        "requestId": request_id,
        "status": status,
        "processedAt": datetime.now(timezone.utc).isoformat(),
    }
    if body:
        result.update(body)
    if error:
        result["error"] = error
    return json.dumps(result)


def _handle_request(payload_bytes: bytes):
    """Process one request (runs in thread pool, NOT on MQTT callback)."""
    t0 = time.monotonic()
    request_id = "unknown"

    try:
        # 1. Parse JSON
        try:
            payload = json.loads(payload_bytes)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            log.warning("Invalid JSON: %s", exc)
            result = _build_result(
                "unknown", "error",
                error={"code": "INVALID_JSON", "message": "Payload is not valid JSON."},
            )
            mqtt_client.publish_result(result)
            _stats["errors"] += 1
            return

        request_id = payload.get("requestId", "unknown")
        message_id = payload.get("messageId", "")

        # 2. QoS 1 dedup by messageId
        if message_id and message_id in _seen_message_ids:
            log.info("Duplicate messageId=%s, ignoring", message_id)
            _stats["duplicates"] += 1
            return

        if message_id:
            _seen_message_ids.add(message_id)
            # Evict oldest if set grows too large
            if len(_seen_message_ids) > config.DEDUP_MAX_SIZE:
                _seen_message_ids.pop()

        # 3. Idempotent requestId — re-publish cached result
        if request_id in _seen_request_ids:
            log.info("Re-publishing cached result for requestId=%s", request_id)
            mqtt_client.publish_result(_seen_request_ids[request_id])
            _stats["duplicates"] += 1
            return

        # 4. Validate schema + business rules
        try:
            schemas.validate(payload)
        except schemas.ValidationError as exc:
            log.warning("Validation failed for requestId=%s: %s", request_id, exc.message)
            result = _build_result(
                request_id, "invalid_request",
                error={"code": exc.code, "message": exc.message},
            )
            mqtt_client.publish_result(result)
            _stats["errors"] += 1
            return

        # 5. Run inference
        body = predictors.predict(payload)

        result = _build_result(request_id, "completed", body=body)

        # 6. Cache for idempotent replays
        _seen_request_ids[request_id] = result
        # ponytail: cap cache same as dedup set
        if len(_seen_request_ids) > config.DEDUP_MAX_SIZE:
            oldest = next(iter(_seen_request_ids))
            del _seen_request_ids[oldest]

        # 7. Publish
        mqtt_client.publish_result(result)
        _stats["processed"] += 1

        latency_ms = (time.monotonic() - t0) * 1000
        log.info(
            "requestId=%s  status=completed  latency=%.1fms  "
            "duration=%.4fh  energy=%.4fkWh  durationModel=%s  energyModel=%s",
            request_id,
            latency_ms,
            body["predictions"]["durationHours"],
            body["predictions"]["energyKwh"],
            body["model"]["durationVersion"],
            body["model"]["energyVersion"],
        )

    except Exception:
        log.exception("Unexpected error processing requestId=%s", request_id)
        result = _build_result(
            request_id, "error",
            error={"code": "INTERNAL_ERROR", "message": "Inference failed."},
        )
        mqtt_client.publish_result(result)
        _stats["errors"] += 1


def _on_message(msg):
    """MQTT on_message callback — dispatches to thread pool immediately."""
    _executor.submit(_handle_request, msg.payload)


def _log_health():
    """Log health metrics."""
    log.info(
        "HEALTH  processed=%d  errors=%d  duplicates=%d  uptime_since=%s",
        _stats["processed"],
        _stats["errors"],
        _stats["duplicates"],
        _stats["started_at"],
    )


def main():
    _stats["started_at"] = datetime.now(timezone.utc).isoformat()
    log.info("ML worker starting — station=%s", config.STATION_ID)
    log.info("Duration model: %s", config.DURATION_MODEL_PATH)
    log.info("Energy model:   %s", config.ENERGY_MODEL_PATH)

    mqtt_client.connect(on_message=_on_message)
    log.info("ML worker ready — waiting for requests on %s", config.TOPIC_REQUESTS)

    # Graceful shutdown
    def _shutdown(sig, frame):
        log.info("Shutting down (signal %s)…", sig)
        _log_health()
        mqtt_client.disconnect()
        _executor.shutdown(wait=False)
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    # Keep main thread alive; log health every 60s
    try:
        while True:
            time.sleep(60)
            _log_health()
    except KeyboardInterrupt:
        _shutdown(signal.SIGINT, None)


if __name__ == "__main__":
    main()
