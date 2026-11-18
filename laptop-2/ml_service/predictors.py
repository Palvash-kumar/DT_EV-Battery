"""Charging and battery-health predictions for a validated request.

  Level 1/2 duration  model trained on 225k real Palo Alto sessions (physics time × learned correction)
  Level 1/2 cost      model trained on real Palo Alto fees
  DC fast charging    physics estimator (no public DC session data)
  energy              physics: SOC window × usable capacity ÷ charging efficiency
  battery wear, RUL   life model trained on ISU-ILCC cells (relative stress effect)

The synthetic ev_charging_patterns.csv is not used: its targets are random with
respect to the inputs (see src/study_ev_charging_patterns.py).
"""

import json
from datetime import datetime

import joblib
import pandas as pd

import battery_health
import charging_physics
from config import DC_PRICE_USD_PER_KWH, MODEL_DIR

MAX_TRAINED_POWER_KW = 7.0  # highest vehicle charging power in the Palo Alto training data

_duration_model = joblib.load(MODEL_DIR / "session_duration.joblib")
_cost_model = joblib.load(MODEL_DIR / "session_cost.joblib")


def _version(meta_file: str, prefix: str) -> str:
    meta = json.loads((MODEL_DIR / meta_file).read_text(encoding="utf-8"))
    return f"{prefix}-{meta['training_date'][:10]}"


DURATION_ML_VERSION = _version("duration_model_metadata.json", "palo-alto-hgb")
COST_ML_VERSION = _version("cost_model_metadata.json", "palo-alto-hgb")
SOH_VERSION = "fleet-age-1.8pct-per-year"

APPLICABILITY_NOTES = [
    "SOH is a fleet-average estimate from vehicle age (about 1.8 % capacity loss per year), not a BMS reading.",
    "Battery wear and RUL use the relative effect of charge rate and depth of discharge measured on ISU-ILCC "
    "NMC lab cells, scaled to a typical EV pack life of 2000 full cycles (assumption).",
    "RUL assumes every future charge is like this one and ignores calendar aging.",
]


def _ml_level2(phys: dict, charger_type: str, now: datetime) -> tuple[float, float, list[str]]:
    vehicle_kw = phys["supplyKw"]
    row = pd.DataFrame([{
        "energy_kwh": phys["energyKwh"], "vehicle_power_kw": vehicle_kw,
        "ideal_h": phys["energyKwh"] / vehicle_kw, "hour": now.hour, "weekday": now.weekday(),
        "month": now.month, "port_type": charger_type,
    }])
    duration = float(_duration_model.predict(row)[0])
    row = row.assign(charge_h=duration, idle_h=0.0)
    cost = max(0.0, float(_cost_model.predict(row)[0]))
    warnings = []
    if vehicle_kw > MAX_TRAINED_POWER_KW:
        warnings.append(f"{vehicle_kw:g} kW is above the charging powers in the training data "
                        f"(up to {MAX_TRAINED_POWER_KW:g} kW); duration is scaled from the physics time.")
    return duration, cost, warnings


def predict(request: dict, now: datetime | None = None) -> tuple[dict, dict]:
    """Return (charging result body, health result body) of native Python types."""
    now = now or datetime.now()
    v, c, e = request["vehicle"], request["charging"], request["environment"]

    phys = charging_physics.estimate(
        vehicle_model=v["model"],
        battery_capacity_kwh=v["batteryCapacityKwh"],
        vehicle_age_years=v["vehicleAgeYears"],
        start_soc_pct=c["startSocPct"],
        target_soc_pct=c["targetSocPct"],
        charger_type=c["chargerType"],
        requested_rate_kw=c["requestedRateKw"],
        temperature_c=e["temperatureC"],
        price_usd_per_kwh={"DC Fast Charger": DC_PRICE_USD_PER_KWH},
    )
    warnings = list(phys["warnings"])

    if c["chargerType"] == "DC Fast Charger":
        duration, cost = phys["durationHours"], phys["costUsd"]
        duration_version = cost_version = charging_physics.VERSION
    else:
        duration, cost, ml_warnings = _ml_level2(phys, c["chargerType"], now)
        warnings += ml_warnings
        duration_version, cost_version = DURATION_ML_VERSION, COST_ML_VERSION

    wear = battery_health.estimate(
        soh_pct=phys["estimatedSohPct"], battery_kwh=phys["batteryKwh"], capacity_kwh=v["batteryCapacityKwh"],
        usable_kwh=phys["usableKwh"], duration_h=duration,
        start_soc_pct=c["startSocPct"], target_soc_pct=c["targetSocPct"],
    )
    warnings += wear["warnings"]

    charging = {
        "predictions": {
            "durationHours": round(duration, 4),
            "energyKwh": phys["energyKwh"],
            "costUsd": round(cost, 2),
            "estimatedSohPct": phys["estimatedSohPct"],
            "batteryWearPct": wear["batteryWearPct"],
            "wearFactor": wear["wearFactor"],
        },
        "model": {
            "durationVersion": duration_version,
            "energyVersion": charging_physics.VERSION,
            "costVersion": cost_version,
            "wearVersion": battery_health.VERSION,
        },
        "warnings": warnings,
    }
    health = {
        "health": {
            "sohPct": phys["estimatedSohPct"],
            "rulCycles": wear["rulCycles"],
            "eolThresholdSohPct": battery_health.EOL_SOH_PCT,
        },
        "model": {"sohVersion": SOH_VERSION, "rulVersion": battery_health.VERSION},
        "warnings": wear["warnings"],
        "applicabilityNotes": APPLICABILITY_NOTES,
    }
    return charging, health
