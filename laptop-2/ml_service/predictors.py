"""Load trained sklearn pipelines once and expose a predict() function."""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from config import (
    DURATION_MODEL_PATH,
    ENERGY_MODEL_PATH,
    DURATION_META_PATH,
    ENERGY_META_PATH,
)

log = logging.getLogger(__name__)

# ── Feature-name mapping ─────────────────────────────────────────────────────
# Maps MQTT request JSON paths → DataFrame column names the pipelines expect.
# Duration model features (from metadata):
#   numeric:  Battery Capacity (kWh), State of Charge (Start %),
#             State of Charge (End %), Charging Rate (kW),
#             Temperature (°C), Vehicle Age (years),
#             socDelta, startHour, isWeekend
#   categorical: Vehicle Model, Charger Type,
#                Charging Station Location, Time of Day, User Type
#
# Energy model adds: requiredEnergyApprox


def _load(model_path: Path, meta_path: Path, label: str):
    """Load a joblib pipeline + JSON metadata; validate feature list."""
    if not model_path.exists():
        raise FileNotFoundError(f"{label} model not found: {model_path}")
    if not meta_path.exists():
        raise FileNotFoundError(f"{label} metadata not found: {meta_path}")

    model = joblib.load(model_path)
    with open(meta_path) as f:
        meta = json.load(f)

    expected = set(meta["features_numeric"] + meta["features_categorical"])
    prep = model.named_steps["prep"]
    actual = set()
    for _name, _trans, cols in prep.transformers_:
        actual.update(cols)

    if expected != actual:
        raise ValueError(
            f"{label}: metadata features {expected} != pipeline features {actual}"
        )
    log.info(
        "%s model loaded (%s, trained %s)",
        label,
        meta["selected_model"],
        meta.get("training_date", "unknown"),
    )
    return model, meta


# ── Module-level singletons (loaded once at import) ──────────────────────────
_dur_model, _dur_meta = _load(
    DURATION_MODEL_PATH, DURATION_META_PATH, "Duration"
)
_nrg_model, _nrg_meta = _load(
    ENERGY_MODEL_PATH, ENERGY_META_PATH, "Energy"
)


def _training_date(meta: dict) -> str:
    """Extract YYYY-MM-DD from metadata training_date."""
    raw = meta.get("training_date", "")
    try:
        return raw[:10]
    except Exception:
        return "unknown"


def _request_to_row(req: dict) -> dict:
    """Map a validated MQTT charging-request to the flat dict both pipelines need."""
    v = req["vehicle"]
    c = req["charging"]
    e = req["environment"]
    now = datetime.now(timezone.utc)

    soc_delta = c["targetSocPct"] - c["startSocPct"]
    # requiredEnergyApprox ≈ capacity × ΔSOC / 100
    req_energy = v["batteryCapacityKwh"] * soc_delta / 100.0

    return {
        "Battery Capacity (kWh)": v["batteryCapacityKwh"],
        "State of Charge (Start %)": c["startSocPct"],
        "State of Charge (End %)": c["targetSocPct"],
        "Charging Rate (kW)": c["requestedRateKw"],
        "Temperature (°C)": e["temperatureC"],
        "Vehicle Age (years)": v["vehicleAgeYears"],
        "socDelta": soc_delta,
        "requiredEnergyApprox": req_energy,
        "startHour": now.hour,
        "isWeekend": int(now.weekday() >= 5),
        # Categorical
        "Vehicle Model": v["model"],
        "Charger Type": c["chargerType"],
        # ponytail: These two columns aren't in the MQTT request; the training
        # data had them but they're meaningless in production. Use the most
        # frequent training value so the one-hot encoder doesn't error.
        "Charging Station Location": "Houston, TX",
        "Time of Day": "Morning",
        "User Type": "Regular",
    }


def predict(request: dict) -> dict:
    """Run duration + energy prediction on a validated request dict.

    Returns a result body (predictions, model versions, warnings).
    All values are native Python types (safe for json.dumps).
    """
    row = _request_to_row(request)
    df = pd.DataFrame([row])

    dur_pred = float(_dur_model.predict(df)[0])
    nrg_pred = float(_nrg_model.predict(df)[0])

    # Clamp negatives — model is weak (R²≈0) so negative estimates can happen
    warnings = []
    if dur_pred < 0:
        warnings.append("Duration prediction was negative; clamped to 0.")
        dur_pred = 0.0
    if nrg_pred < 0:
        warnings.append("Energy prediction was negative; clamped to 0.")
        nrg_pred = 0.0

    warnings.append(
        "Predictions are ML estimates from synthetic training data, not physically validated."
    )

    return {
        "predictions": {
            "durationHours": round(dur_pred, 4),
            "energyKwh": round(nrg_pred, 4),
        },
        "model": {
            "durationVersion": _training_date(_dur_meta),
            "energyVersion": _training_date(_nrg_meta),
        },
        "warnings": warnings,
    }
