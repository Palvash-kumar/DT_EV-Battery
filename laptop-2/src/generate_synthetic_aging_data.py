#!/usr/bin/env python3
"""
generate_synthetic_aging_data.py — Generate a physics-based synthetic battery aging dataset.

ONLY used as a fallback when the real NASA PCoE Battery Dataset cannot be obtained.
Generates realistic Li-ion capacity fade curves based on published empirical models:
  Q(n) = Q_nominal × (1 - α × n^β)
where α depends on temperature, C-rate, and depth-of-discharge.

References:
  - Bloom et al. (2001) J. Power Sources — Power-law calendar aging model
  - Wang et al. (2014) J. Power Sources — Cycle aging with stress factors
  - Birkl et al. (2017) J. Power Sources — Capacity fade knee-point behavior

Usage:
    python src/generate_synthetic_aging_data.py
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

SEED = 42
OUT_DIR = Path(os.path.dirname(__file__)) / ".." / "data" / "battery_aging" / "raw"


def generate() -> Path:
    rng = np.random.default_rng(SEED)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # Define 8 batteries with varying test conditions (mimicking NASA PCoE B0005-B0018 subset)
    batteries = [
        {"id": "B0005", "chemistry": "Li-ion 18650", "nominal_ah": 2.0, "temp_c": 24, "charge_rate": 1.0, "discharge_rate": 2.0, "dod_pct": 100, "max_cycles": 616},
        {"id": "B0006", "chemistry": "Li-ion 18650", "nominal_ah": 2.0, "temp_c": 24, "charge_rate": 1.0, "discharge_rate": 2.0, "dod_pct": 100, "max_cycles": 616},
        {"id": "B0007", "chemistry": "Li-ion 18650", "nominal_ah": 2.0, "temp_c": 24, "charge_rate": 1.0, "discharge_rate": 2.0, "dod_pct": 100, "max_cycles": 616},
        {"id": "B0018", "chemistry": "Li-ion 18650", "nominal_ah": 2.0, "temp_c": 24, "charge_rate": 1.0, "discharge_rate": 2.0, "dod_pct": 100, "max_cycles": 530},
        {"id": "B0025", "chemistry": "Li-ion 18650", "nominal_ah": 2.0, "temp_c": 43, "charge_rate": 1.0, "discharge_rate": 1.0, "dod_pct": 100, "max_cycles": 474},
        {"id": "B0026", "chemistry": "Li-ion 18650", "nominal_ah": 2.0, "temp_c": 43, "charge_rate": 1.0, "discharge_rate": 1.0, "dod_pct": 100, "max_cycles": 474},
        {"id": "B0033", "chemistry": "Li-ion 18650", "nominal_ah": 2.0, "temp_c": 4,  "charge_rate": 1.0, "discharge_rate": 2.0, "dod_pct": 100, "max_cycles": 580},
        {"id": "B0034", "chemistry": "Li-ion 18650", "nominal_ah": 2.0, "temp_c": 4,  "charge_rate": 1.0, "discharge_rate": 2.0, "dod_pct": 100, "max_cycles": 580},
    ]

    all_rows = []
    for bat in batteries:
        n_cycles = bat["max_cycles"]
        cycles = np.arange(1, n_cycles + 1)

        # Degradation rate depends on temperature and discharge rate
        # Higher temp → faster degradation (Arrhenius-like)
        # Higher C-rate → faster degradation
        # Calibrated so batteries reach ~70-85% SOH by end of cycling
        # (matching NASA PCoE B0005-B0018 real behavior)
        temp_factor = np.exp(0.035 * (bat["temp_c"] - 25))  # Arrhenius-like
        rate_factor = 1.0 + 0.2 * (bat["discharge_rate"] - 1.0)
        alpha = 0.008 * temp_factor * rate_factor
        beta = 0.55  # power-law exponent (from published literature: 0.5–0.7)

        # Add battery-specific random offset for realistic variation
        alpha *= (1 + rng.normal(0, 0.08))

        # Capacity fade: Q(n) = Q_nominal × (1 - α × n^β)
        q_nominal = bat["nominal_ah"]
        capacity = q_nominal * (1 - alpha * cycles ** beta)

        # Add measurement noise (realistic: ~0.5% of nominal)
        noise = rng.normal(0, 0.005 * q_nominal, size=n_cycles)
        capacity = capacity + noise

        # Add "knee-point" acceleration for batteries that degrade far enough
        # (after ~70-75% SOH, degradation accelerates in real batteries)
        soh = capacity / q_nominal * 100
        knee_mask = soh < 78
        if knee_mask.any():
            knee_idx = np.where(knee_mask)[0][0]
            accel = np.zeros(n_cycles)
            accel[knee_idx:] = np.cumsum(
                rng.uniform(0.0005, 0.002, size=n_cycles - knee_idx)
            )
            capacity[knee_idx:] -= accel[knee_idx:]

        # Ensure capacity doesn't go below a floor
        capacity = np.maximum(capacity, 0.5)

        # Internal resistance increases with aging (correlated with capacity loss)
        r_internal_initial = 0.03 + rng.normal(0, 0.002)  # ~30 mΩ
        r_internal = r_internal_initial * (1 + 0.8 * (1 - capacity / q_nominal))
        r_internal += rng.normal(0, 0.001, size=n_cycles)
        r_internal = np.maximum(r_internal, 0.02)

        # Temperature per cycle: slight variation around test temperature
        cycle_temp = bat["temp_c"] + rng.normal(0, 1.5, size=n_cycles)

        for i, cyc in enumerate(cycles):
            all_rows.append({
                "battery_id": bat["id"],
                "cycle": int(cyc),
                "discharge_capacity_ah": round(float(capacity[i]), 6),
                "charge_capacity_ah": round(float(capacity[i] * (1 + rng.uniform(0.001, 0.005))), 6),
                "internal_resistance_ohm": round(float(r_internal[i]), 6),
                "temperature_c": round(float(cycle_temp[i]), 1),
                "nominal_capacity_ah": q_nominal,
                "charge_rate_c": bat["charge_rate"],
                "discharge_rate_c": bat["discharge_rate"],
                "dod_pct": bat["dod_pct"],
                "chemistry": bat["chemistry"],
            })

    df = pd.DataFrame(all_rows)
    out_path = OUT_DIR / "battery_aging_cycles.csv"
    df.to_csv(out_path, index=False)

    # Save generation metadata
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "synthetic — physics-based empirical model",
        "model": "Q(n) = Q_nominal × (1 - α × n^β) with Arrhenius temperature factor and knee-point acceleration",
        "references": [
            "Bloom et al. (2001) J. Power Sources — calendar aging power law",
            "Wang et al. (2014) J. Power Sources — multi-stress cycle aging",
            "Birkl et al. (2017) J. Power Sources — capacity fade knee-point",
        ],
        "batteries": [b["id"] for b in batteries],
        "total_rows": len(df),
        "seed": SEED,
    }
    with open(OUT_DIR / "generation_metadata.json", "w") as f:
        json.dump(meta, f, indent=2)

    print(f"✅ Generated {len(df)} rows for {len(batteries)} batteries → {out_path}")
    return out_path


if __name__ == "__main__":
    generate()
