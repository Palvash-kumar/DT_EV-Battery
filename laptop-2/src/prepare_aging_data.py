#!/usr/bin/env python3
"""
prepare_aging_data.py — Extract and normalize battery aging data into a standard CSV.

Handles two sources:
  1. NASA PCoE Battery Dataset (.mat files) — if zip was downloaded
  2. Synthetic data from generate_synthetic_aging_data.py — fallback

Produces: data/battery_aging/processed/aging_normalized.parquet
  Columns: battery_id, cycle, discharge_capacity_ah, nominal_capacity_ah,
           soh_pct, temperature_c, charge_rate_c, discharge_rate_c, dod_pct, chemistry

Usage:
    cd laptop-2
    source .venv/bin/activate
    python src/prepare_aging_data.py
"""

from __future__ import annotations

import json
import os
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

RAW_DIR = Path(os.path.dirname(__file__)) / ".." / "data" / "battery_aging" / "raw"
PROC_DIR = Path(os.path.dirname(__file__)) / ".." / "data" / "battery_aging" / "processed"
NASA_ZIP = RAW_DIR / "nasa_battery.zip"
SYNTH_CSV = RAW_DIR / "battery_aging_cycles.csv"

# NASA batteries we want (the well-known aging subset)
NASA_BATTERIES = ["B0005", "B0006", "B0007", "B0018", "B0025", "B0026", "B0033", "B0034"]

EOL_SOH_PCT = 80.0  # configurable end-of-life threshold


def extract_nasa_mat_files() -> Path:
    """Extract .mat files from NASA zip if present."""
    extract_dir = RAW_DIR / "nasa_extracted"
    if extract_dir.exists() and any(extract_dir.rglob("*.mat")):
        return extract_dir
    extract_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(NASA_ZIP, "r") as zf:
        zf.extractall(extract_dir)
    return extract_dir


def load_nasa_data() -> pd.DataFrame:
    """Load NASA PCoE .mat files and extract discharge capacity per cycle."""
    from scipy.io import loadmat

    extract_dir = extract_nasa_mat_files()

    # Find .mat files
    mat_files = list(extract_dir.rglob("*.mat"))
    # Filter to our target batteries
    target_mats = []
    for mf in mat_files:
        stem = mf.stem
        if stem in NASA_BATTERIES:
            target_mats.append((stem, mf))

    if not target_mats:
        raise FileNotFoundError(
            f"No .mat files found for batteries {NASA_BATTERIES} in {extract_dir}"
        )

    all_rows = []
    for bat_id, mat_path in sorted(target_mats):
        mat = loadmat(str(mat_path))
        # NASA structure: mat[bat_id]['cycle'][0,0][0] contains cycle data
        # Each cycle has: type (charge/discharge/impedance), ambient_temperature,
        # time, voltage_measured, current_measured, capacity, etc.
        bat_struct = mat[bat_id]
        cycles = bat_struct["cycle"][0, 0][0]

        discharge_cycle_num = 0
        for i, cyc in enumerate(cycles):
            cyc_type = str(cyc["type"][0])
            if cyc_type != "discharge":
                continue

            discharge_cycle_num += 1
            try:
                capacity = float(cyc["data"][0, 0]["Capacity"][0, 0])
                temp = float(cyc["ambient_temperature"][0, 0])
            except (IndexError, KeyError, ValueError):
                continue

            if capacity <= 0 or np.isnan(capacity):
                continue

            all_rows.append({
                "battery_id": bat_id,
                "cycle": discharge_cycle_num,
                "discharge_capacity_ah": round(capacity, 6),
                "temperature_c": round(temp, 1),
                "nominal_capacity_ah": 2.0,  # NASA 18650 cells are rated 2 Ah
                "charge_rate_c": 1.0,  # CC charging at 1.5A ≈ 0.75C, approximate as 1C
                "discharge_rate_c": 2.0,  # 2A discharge ≈ 1C, some at 4A ≈ 2C
                "dod_pct": 100,
                "chemistry": "Li-ion 18650 (LiCoO2)",
            })

    if not all_rows:
        raise ValueError("No discharge capacity data extracted from NASA .mat files")

    return pd.DataFrame(all_rows)


def load_synthetic_data() -> pd.DataFrame:
    """Load pre-generated synthetic aging data."""
    if not SYNTH_CSV.exists():
        # Generate it
        from generate_synthetic_aging_data import generate
        generate()
    return pd.read_csv(SYNTH_CSV)


def normalize(df: pd.DataFrame) -> pd.DataFrame:
    """Add SOH and RUL columns."""
    df = df.copy()

    # SOH = currentCapacity / nominalCapacity × 100
    df["soh_pct"] = (df["discharge_capacity_ah"] / df["nominal_capacity_ah"]) * 100

    # Capacity loss in Ah
    df["capacity_loss_ah"] = df["nominal_capacity_ah"] - df["discharge_capacity_ah"]

    # RUL: for each battery, find the cycle where SOH first drops below EOL_SOH_PCT
    # Then RUL = eol_cycle - current_cycle (NaN if battery never reaches EOL)
    rul_values = []
    for bat_id, group in df.groupby("battery_id"):
        eol_rows = group[group["soh_pct"] <= EOL_SOH_PCT]
        if len(eol_rows) > 0:
            eol_cycle = eol_rows["cycle"].iloc[0]
        else:
            # Extrapolate: use last known capacity trend
            # ponytail: simple linear extrapolation from last 20% of data
            tail = group.tail(max(10, len(group) // 5))
            if len(tail) >= 2 and tail["soh_pct"].std() > 0.01:
                slope = np.polyfit(tail["cycle"], tail["soh_pct"], 1)[0]
                if slope < 0:
                    last_soh = group["soh_pct"].iloc[-1]
                    last_cycle = group["cycle"].iloc[-1]
                    eol_cycle = int(last_cycle + (last_soh - EOL_SOH_PCT) / (-slope))
                else:
                    eol_cycle = None
            else:
                eol_cycle = None

        for _, row in group.iterrows():
            if eol_cycle is not None:
                rul = max(0, eol_cycle - row["cycle"])
            else:
                rul = None
            rul_values.append(rul)

    df["rul_cycles"] = rul_values
    df["eol_threshold_soh_pct"] = EOL_SOH_PCT

    return df


def run():
    PROC_DIR.mkdir(parents=True, exist_ok=True)

    # Try NASA data first, fall back to synthetic
    source = "unknown"
    try:
        if NASA_ZIP.exists() and NASA_ZIP.stat().st_size > 1_000_000:
            print("📦 Found NASA PCoE Battery Dataset zip — extracting...")
            df = load_nasa_data()
            source = "NASA PCoE Battery Dataset (B0005-B0034)"
            print(f"   Loaded {len(df)} discharge cycles from {df['battery_id'].nunique()} batteries")
        else:
            raise FileNotFoundError("No NASA zip")
    except Exception as e:
        print(f"⚠️  NASA data not available ({e}). Using synthetic aging data.")
        df = load_synthetic_data()
        source = "Synthetic — physics-based empirical degradation model (seed=42)"
        print(f"   Loaded {len(df)} rows from {df['battery_id'].nunique()} batteries")

    # Normalize
    df = normalize(df)

    # Save
    out_path = PROC_DIR / "aging_normalized.parquet"
    df.to_parquet(out_path, index=False)

    # Summary
    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": source,
        "eol_threshold_soh_pct": EOL_SOH_PCT,
        "total_rows": len(df),
        "batteries": sorted(df["battery_id"].unique().tolist()),
        "battery_count": int(df["battery_id"].nunique()),
        "cycles_per_battery": df.groupby("battery_id")["cycle"].max().to_dict(),
        "soh_range": {"min": round(float(df["soh_pct"].min()), 2), "max": round(float(df["soh_pct"].max()), 2)},
        "batteries_reaching_eol": int((df.groupby("battery_id")["soh_pct"].min() <= EOL_SOH_PCT).sum()),
        "columns": df.columns.tolist(),
    }
    with open(PROC_DIR / "aging_summary.json", "w") as f:
        json.dump(summary, f, indent=2)

    print(f"\n✅ Normalized aging data saved to {out_path}")
    print(f"   {len(df)} rows, {df['battery_id'].nunique()} batteries")
    print(f"   SOH range: {df['soh_pct'].min():.1f}% — {df['soh_pct'].max():.1f}%")
    print(f"   Batteries reaching EOL (≤{EOL_SOH_PCT}%): {summary['batteries_reaching_eol']}")
    return summary


if __name__ == "__main__":
    run()
