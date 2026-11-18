"""Battery wear of one charging session and the vehicle's remaining life.

The life model (trained on ISU-ILCC lab cells) gives how charge rate and depth
of discharge change cycle life. Lab cells age much faster in absolute terms
than EV packs, so only the *relative* effect is transferred: the session's
life multiplier versus a gentle reference charge, applied to a typical EV pack
life of EV_REFERENCE_LIFE_EFC equivalent full cycles.
"""

from __future__ import annotations

import joblib
import numpy as np
import pandas as pd

from config import MODEL_DIR

VERSION = "isu-life-1.0"
EOL_SOH_PCT = 80.0
# Typical NMC EV cell rating: ~2000 full cycles to 80 % under gentle charging (assumption)
EV_REFERENCE_LIFE_EFC = 2000.0
REFERENCE_CHARGE_C, REFERENCE_DISCHARGE_C, REFERENCE_DOD_PCT = 0.5, 0.5, 50.0
# Ranges tested in ISU-ILCC; inputs are clamped to them
CHARGE_C_RANGE, DOD_RANGE = (0.5, 3.0), (4.0, 98.0)

_life_model = joblib.load(MODEL_DIR / "battery_life.joblib")


def _life_efc(charge_c: float, dod_pct: float) -> float:
    # Faster charging is never treated as gentler: take the shortest life over all slower rates.
    # (In the lab data 1-2C sometimes outlived 0.5C, which is cell-to-cell noise, not physics.)
    rates = np.linspace(CHARGE_C_RANGE[0], charge_c, 11)
    x = pd.DataFrame({"charge_c": rates, "discharge_c": REFERENCE_DISCHARGE_C, "dod_pct": dod_pct})
    return float(np.exp(_life_model.predict(x)).min())


_REFERENCE_LIFE = _life_efc(REFERENCE_CHARGE_C, REFERENCE_DOD_PCT)


def estimate(*, soh_pct: float, battery_kwh: float, capacity_kwh: float, usable_kwh: float,
             duration_h: float, start_soc_pct: float, target_soc_pct: float) -> dict:
    warnings: list[str] = []
    charge_c = (battery_kwh / duration_h) / usable_kwh if duration_h > 0 else 0.0
    dod = target_soc_pct - start_soc_pct
    c_used = float(np.clip(charge_c, *CHARGE_C_RANGE))
    dod_used = float(np.clip(dod, *DOD_RANGE))
    if charge_c > CHARGE_C_RANGE[1]:
        warnings.append(f"Charge rate {charge_c:.1f}C is above the tested range; wear uses 3C.")

    wear_factor = _REFERENCE_LIFE / _life_efc(c_used, dod_used)
    ev_life_efc = EV_REFERENCE_LIFE_EFC / wear_factor
    session_efc = battery_kwh / capacity_kwh
    return {
        "chargeCRate": round(charge_c, 3),
        "wearFactor": round(wear_factor, 2),
        "batteryWearPct": round(session_efc * (100 - EOL_SOH_PCT) / ev_life_efc, 5),
        "rulCycles": round(max(0.0, soh_pct - EOL_SOH_PCT) / (100 - EOL_SOH_PCT) * ev_life_efc, 0),
        "warnings": warnings,
    }
