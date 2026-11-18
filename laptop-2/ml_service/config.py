"""Configuration loaded from environment / .env file."""

import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env from the same directory as this file
_env_path = Path(__file__).resolve().parent / ".env"
load_dotenv(_env_path)


def _require(key: str) -> str:
    val = os.environ.get(key)
    if not val:
        raise EnvironmentError(f"Missing required env var: {key}")
    return val


# ── MQTT ──────────────────────────────────────────────────────────────────────
MQTT_HOST = _require("MQTT_HOST")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
MQTT_USERNAME = _require("MQTT_USERNAME")
MQTT_PASSWORD = _require("MQTT_PASSWORD")

# ── Topics ────────────────────────────────────────────────────────────────────
TOPIC_REQUESTS = os.environ.get("MQTT_TOPIC_REQUESTS", "evdt/v1/requests/charging")
TOPIC_RESULTS = os.environ.get("MQTT_TOPIC_RESULTS_CHARGING", "evdt/v1/results/charging")
TOPIC_RESULTS_HEALTH = os.environ.get("MQTT_TOPIC_RESULTS_HEALTH", "evdt/v1/results/health")

# ── Station ───────────────────────────────────────────────────────────────────
STATION_ID = os.environ.get("STATION_ID", "STATION-001")

# ── Models ────────────────────────────────────────────────────────────────────
MODEL_DIR = Path(__file__).resolve().parent.parent / "models"

# ── DC fast charging price (USD per kWh); Level 1/2 cost comes from the trained cost model
DC_PRICE_USD_PER_KWH = float(os.environ.get("PRICE_DCFC_USD_PER_KWH", "0.48"))

# ── Misc ──────────────────────────────────────────────────────────────────────
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
REQUEST_TIMEOUT_SEC = int(os.environ.get("REQUEST_TIMEOUT_SEC", "15"))
# ponytail: in-memory dedup set; fine for single-process prototype.
DEDUP_MAX_SIZE = 10_000
