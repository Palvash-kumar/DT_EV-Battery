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

# ── Station ───────────────────────────────────────────────────────────────────
STATION_ID = os.environ.get("STATION_ID", "STATION-001")

# ── Models ────────────────────────────────────────────────────────────────────
_ml_service_dir = Path(__file__).resolve().parent
_raw_model_dir = os.environ.get("MODEL_DIR", "")
if _raw_model_dir:
    MODEL_DIR = (_ml_service_dir / _raw_model_dir).resolve()
else:
    MODEL_DIR = _ml_service_dir.parent / "models"

DURATION_MODEL_PATH = MODEL_DIR / "charging_duration.joblib"
ENERGY_MODEL_PATH = MODEL_DIR / "energy.joblib"
DURATION_META_PATH = MODEL_DIR / "duration_model_metadata.json"
ENERGY_META_PATH = MODEL_DIR / "energy_model_metadata.json"

# ── Misc ──────────────────────────────────────────────────────────────────────
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
REQUEST_TIMEOUT_SEC = int(os.environ.get("REQUEST_TIMEOUT_SEC", "15"))
# ponytail: in-memory dedup set; fine for single-process prototype.
DEDUP_MAX_SIZE = 10_000
