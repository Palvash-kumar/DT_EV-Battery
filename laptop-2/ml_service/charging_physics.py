"""Physics-based charging estimator: duration, grid energy, cost and battery SOH.

Every constant below is an approximate public figure, not a measurement from
this project. They are grouped here so they can be reviewed and tuned.
"""

from __future__ import annotations

import numpy as np

VERSION = "physics-1.0"

CHARGER_MAX_KW = {"Level 1": 1.9, "Level 2": 19.2, "DC Fast Charger": 350.0}

# (on-board AC charger limit kW, peak DC acceptance kW), approximate manufacturer specs
VEHICLE_LIMITS_KW = {
    "BMW i3": (7.4, 50.0),
    "Chevy Bolt": (7.2, 55.0),
    "Hyundai Kona": (7.2, 77.0),
    "Nissan Leaf": (6.6, 50.0),
    "Tesla Model 3": (11.5, 250.0),
}
DEFAULT_VEHICLE_LIMITS_KW = (7.2, 50.0)

# Grid-to-battery efficiency at mild temperatures
BASE_EFFICIENCY = {"Level 1": 0.85, "Level 2": 0.90, "DC Fast Charger": 0.93}

# Max charge rate the cells accept at a given SOC, in C (kW per kWh of usable capacity).
# Typical lithium-ion CC-CV taper: high current when empty, tapering hard above ~80 %.
TAPER_SOC = np.array([0.0, 20.0, 50.0, 80.0, 90.0, 100.0])
TAPER_C_RATE = np.array([3.0, 3.0, 2.0, 0.9, 0.5, 0.2])

# Fleet studies report roughly 1.8 % capacity loss per year of vehicle age
SOH_LOSS_PCT_PER_YEAR = 1.8
SOH_FLOOR_PCT = 70.0

DEFAULT_PRICE_USD_PER_KWH = {"Level 1": 0.17, "Level 2": 0.30, "DC Fast Charger": 0.48}

SOC_STEP_PCT = 0.25


def estimated_soh_pct(vehicle_age_years: float) -> float:
    return max(SOH_FLOOR_PCT, 100.0 - SOH_LOSS_PCT_PER_YEAR * vehicle_age_years)


def efficiency(charger_type: str, temperature_c: float) -> float:
    eff = BASE_EFFICIENCY.get(charger_type, 0.88)
    # Energy spent heating (cold) or cooling (hot) the pack
    if temperature_c < 10:
        eff -= min(0.20, 0.006 * (10 - temperature_c))
    elif temperature_c > 35:
        eff -= min(0.10, 0.004 * (temperature_c - 35))
    return eff


def thermal_acceptance(temperature_c: float) -> float:
    # Cold cells limit charge current to avoid lithium plating; hot cells are throttled
    if temperature_c < 15:
        return float(np.clip(0.3 + 0.7 * (temperature_c + 10) / 25, 0.3, 1.0))
    if temperature_c > 40:
        return 0.85
    return 1.0


def estimate(
    *,
    vehicle_model: str,
    battery_capacity_kwh: float,
    vehicle_age_years: float,
    start_soc_pct: float,
    target_soc_pct: float,
    charger_type: str,
    requested_rate_kw: float,
    temperature_c: float,
    price_usd_per_kwh: dict[str, float] | None = None,
) -> dict:
    prices = price_usd_per_kwh or DEFAULT_PRICE_USD_PER_KWH
    warnings: list[str] = []

    ac_max_kw, dc_max_kw = VEHICLE_LIMITS_KW.get(vehicle_model, DEFAULT_VEHICLE_LIMITS_KW)
    charger_max_kw = CHARGER_MAX_KW.get(charger_type, requested_rate_kw)
    supply_kw = min(requested_rate_kw, charger_max_kw)
    if requested_rate_kw > charger_max_kw:
        warnings.append(
            f"Requested {requested_rate_kw:g} kW exceeds the {charger_type} limit; used {charger_max_kw:g} kW."
        )
    if charger_type != "DC Fast Charger" and supply_kw > ac_max_kw:
        warnings.append(
            f"{vehicle_model} on-board charger accepts about {ac_max_kw:g} kW on AC; used that instead."
        )
        supply_kw = ac_max_kw

    soh = estimated_soh_pct(vehicle_age_years)
    usable_kwh = battery_capacity_kwh * soh / 100.0
    eff = efficiency(charger_type, temperature_c)

    socs = np.arange(start_soc_pct, target_soc_pct, SOC_STEP_PCT)
    steps = np.minimum(SOC_STEP_PCT, target_soc_pct - socs)
    battery_kwh_steps = usable_kwh * steps / 100.0
    mid_soc = socs + steps / 2
    cell_limit_kw = usable_kwh * np.interp(mid_soc, TAPER_SOC, TAPER_C_RATE)
    accept_kw = np.minimum(dc_max_kw, cell_limit_kw) * thermal_acceptance(temperature_c)
    battery_kw = np.minimum(supply_kw * eff, accept_kw)

    battery_kwh = float(battery_kwh_steps.sum())
    duration_h = float((battery_kwh_steps / battery_kw).sum())
    grid_kwh = battery_kwh / eff
    cost_usd = grid_kwh * prices.get(charger_type, DEFAULT_PRICE_USD_PER_KWH["Level 2"])

    if temperature_c < 0:
        warnings.append("Cold battery: charging is slower and less efficient below 0 °C.")

    return {
        "durationHours": round(duration_h, 4),
        "energyKwh": round(grid_kwh, 4),
        "costUsd": round(cost_usd, 2),
        "estimatedSohPct": round(soh, 1),
        "warnings": warnings,
        # Intermediate values used by the ML and battery-wear models
        "supplyKw": supply_kw,
        "batteryKwh": battery_kwh,
        "usableKwh": usable_kwh,
    }
