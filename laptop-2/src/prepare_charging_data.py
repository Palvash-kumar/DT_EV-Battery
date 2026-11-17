#!/usr/bin/env python3
"""
prepare_charging_data.py — Reproducible cleaning pipeline for ev_charging_patterns.csv

Reads the raw 1,320-row CSV, validates domain rules, flags inconsistencies,
derives features, and writes a cleaned Parquet file.  The source CSV is never
modified.

Usage:
    cd laptop-2
    source .venv/bin/activate
    python src/prepare_charging_data.py          # defaults
    python src/prepare_charging_data.py --src ../Data/ev_charging_patterns.csv \
                                        --out data/processed/charging_clean.parquet
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
EXPECTED_COLUMNS = [
    "User ID", "Vehicle Model", "Battery Capacity (kWh)",
    "Charging Station ID", "Charging Station Location",
    "Charging Start Time", "Charging End Time",
    "Energy Consumed (kWh)", "Charging Duration (hours)",
    "Charging Rate (kW)", "Charging Cost (USD)",
    "Time of Day", "Day of Week",
    "State of Charge (Start %)", "State of Charge (End %)",
    "Distance Driven (since last charge) (km)",
    "Temperature (°C)", "Vehicle Age (years)",
    "Charger Type", "User Type",
]

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_raw(path: str | Path) -> pd.DataFrame:
    """Load CSV with explicit timestamp parsing; fail fast on schema drift."""
    df = pd.read_csv(
        path,
        parse_dates=["Charging Start Time", "Charging End Time"],
    )
    missing = set(EXPECTED_COLUMNS) - set(df.columns)
    if missing:
        sys.exit(f"Missing columns in source CSV: {missing}")
    return df


def profile(df: pd.DataFrame) -> dict:
    """Return a summary profile dict (nulls, dtypes, ranges, uniques)."""
    info: dict = {
        "row_count": len(df),
        "column_count": len(df.columns),
        "nulls_per_column": df.isnull().sum().to_dict(),
        "total_nulls": int(df.isnull().sum().sum()),
        "duplicated_rows": int(df.duplicated().sum()),
        "dtypes": df.dtypes.astype(str).to_dict(),
    }
    # Numeric ranges
    num_cols = df.select_dtypes(include="number").columns.tolist()
    info["numeric_ranges"] = {
        c: {"min": float(df[c].min()), "max": float(df[c].max())}
        for c in num_cols
    }
    # Categorical uniques
    cat_cols = df.select_dtypes(include=["object", "str"]).columns.tolist()
    info["categorical_uniques"] = {c: df[c].nunique() for c in cat_cols}
    return info


# ---------------------------------------------------------------------------
# Validation — flag, don't silently fix
# ---------------------------------------------------------------------------

def validate(df: pd.DataFrame) -> pd.DataFrame:
    """Add a dataQualityFlag column; each row gets a list of issues (or empty)."""
    flags: list[list[str]] = [[] for _ in range(len(df))]

    # 1. Battery capacity > 0
    mask = df["Battery Capacity (kWh)"] <= 0
    for i in mask[mask].index:
        flags[i].append("battery_capacity_le_0")

    # 2. 0 ≤ start SOC < end SOC ≤ 100
    soc_s = df["State of Charge (Start %)"]
    soc_e = df["State of Charge (End %)"]
    for i in (soc_s < 0)[lambda s: s].index:
        flags[i].append("start_soc_negative")
    for i in (soc_e > 100)[lambda s: s].index:
        flags[i].append("end_soc_gt_100")
    for i in (soc_s >= soc_e)[lambda s: s].index:
        flags[i].append("start_soc_gte_end_soc")

    # 3. Energy, duration, rate, cost ≥ 0
    for col, tag in [
        ("Energy Consumed (kWh)", "energy_negative"),
        ("Charging Duration (hours)", "duration_negative"),
        ("Charging Rate (kW)", "rate_negative"),
        ("Charging Cost (USD)", "cost_negative"),
    ]:
        for i in (df[col] < 0)[lambda s: s].index:
            flags[i].append(tag)

    # 4. End time after start time
    td = (df["Charging End Time"] - df["Charging Start Time"]).dt.total_seconds() / 3600
    for i in (td <= 0)[lambda s: s].index:
        flags[i].append("end_before_or_equal_start")

    # 5. Recorded duration vs computed duration — flag if >20 % relative diff
    rec_dur = df["Charging Duration (hours)"]
    rel_diff_dur = ((rec_dur - td) / td.replace(0, np.nan)).abs()
    for i in (rel_diff_dur > 0.20).fillna(False)[lambda s: s].index:
        flags[i].append("duration_mismatch_gt_20pct")

    # 6. Approximate energy (duration × rate) vs recorded energy — flag >20 %
    approx_energy = rec_dur * df["Charging Rate (kW)"]
    actual_energy = df["Energy Consumed (kWh)"]
    rel_diff_e = ((actual_energy - approx_energy) / approx_energy.replace(0, np.nan)).abs()
    for i in (rel_diff_e > 0.20).fillna(False)[lambda s: s].index:
        flags[i].append("energy_mismatch_gt_20pct")

    # 7. Energy consumed > battery capacity (physically impossible for a single charge)
    for i in (df["Energy Consumed (kWh)"] > df["Battery Capacity (kWh)"])[lambda s: s].index:
        flags[i].append("energy_exceeds_capacity")

    df = df.copy()
    df["dataQualityFlag"] = ["|".join(f) if f else "" for f in flags]
    return df


# ---------------------------------------------------------------------------
# Feature engineering
# ---------------------------------------------------------------------------

def derive_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    # SOC delta
    df["socDelta"] = df["State of Charge (End %)"] - df["State of Charge (Start %)"]

    # Required energy approximation: socDelta/100 * batteryCapacity
    df["requiredEnergyApprox"] = (df["socDelta"] / 100.0) * df["Battery Capacity (kWh)"]

    # Time features from Charging Start Time
    df["startHour"] = df["Charging Start Time"].dt.hour
    df["isWeekend"] = df["Charging Start Time"].dt.day_of_week.isin([5, 6]).astype(int)
    df["startMonth"] = df["Charging Start Time"].dt.month

    # Computed duration from timestamps (hours)
    df["computedDurationHours"] = (
        (df["Charging End Time"] - df["Charging Start Time"]).dt.total_seconds() / 3600
    )

    # Normalized category: charger type and user type as-is (already clean strings)
    # Vehicle model normalization — strip whitespace
    df["Vehicle Model"] = df["Vehicle Model"].str.strip()
    df["Charger Type"] = df["Charger Type"].str.strip()
    df["User Type"] = df["User Type"].str.strip()

    return df


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run(src: str | Path, out: str | Path) -> dict:
    src = Path(src)
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)

    # 1. Load
    df_raw = load_raw(src)
    raw_rows = len(df_raw)
    profile_raw = profile(df_raw)

    # 2. Validate
    df = validate(df_raw)

    # Count flagged rows
    flagged_mask = df["dataQualityFlag"] != ""
    flagged_count = int(flagged_mask.sum())

    # 3. Derive features
    df = derive_features(df)

    # 4. Imputation — only for nulls that exist; median within vehicle-model group
    numeric_impute_cols = [
        "Battery Capacity (kWh)", "Charging Rate (kW)",
        "Energy Consumed (kWh)", "Distance Driven (since last charge) (km)",
        "Temperature (°C)", "Vehicle Age (years)",
    ]
    imputed_counts: dict[str, int] = {}
    for col in numeric_impute_cols:
        n_null = int(df[col].isnull().sum())
        if n_null > 0:
            df[col] = df.groupby("Vehicle Model")[col].transform(
                lambda s: s.fillna(s.median())
            )
            # fallback: global median if entire group was null
            df[col] = df[col].fillna(df[col].median())
            imputed_counts[col] = n_null

    cat_impute_cols = ["Charger Type", "User Type", "Charging Station Location"]
    for col in cat_impute_cols:
        n_null = int(df[col].isnull().sum())
        if n_null > 0:
            df[col] = df[col].fillna("Unknown")
            imputed_counts[col] = n_null

    # 5. Exclude rows? — We keep all rows but flag them. No silent exclusion.
    final_rows = len(df)

    # 6. Save
    df.to_parquet(out, index=False)

    # 7. Build cleaning summary
    summary = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source_file": str(src),
        "output_file": str(out),
        "raw_row_count": raw_rows,
        "final_row_count": final_rows,
        "rows_excluded": raw_rows - final_rows,
        "rows_flagged": flagged_count,
        "flag_breakdown": (
            df[flagged_mask]["dataQualityFlag"]
            .str.split("|")
            .explode()
            .value_counts()
            .to_dict()
            if flagged_count > 0
            else {}
        ),
        "imputed_counts": imputed_counts,
        "profile_raw": profile_raw,
        "derived_features": [
            "socDelta", "requiredEnergyApprox", "startHour",
            "isWeekend", "startMonth", "computedDurationHours",
        ],
        "notes": [
            "Source CSV is never modified.",
            "No rows excluded — flagged rows kept with dataQualityFlag.",
            "This dataset has one row per user/session, not longitudinal battery history.",
            "Do not claim this data supports per-battery degradation labels.",
        ],
    }

    summary_path = out.parent / "cleaning_summary.json"
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2, default=str)

    print(f"✅ Cleaned data saved to {out}  ({final_rows} rows)")
    print(f"✅ Cleaning summary saved to {summary_path}")
    print(f"   Flagged rows: {flagged_count}/{raw_rows}")
    if imputed_counts:
        print(f"   Imputed columns: {imputed_counts}")
    else:
        print("   No nulls required imputation.")
    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Clean EV charging CSV for digital-twin project")
    parser.add_argument(
        "--src",
        default=os.path.join(os.path.dirname(__file__), "..", "..", "Data", "ev_charging_patterns.csv"),
        help="Path to source CSV (default: Data/ev_charging_patterns.csv)",
    )
    parser.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(__file__), "..", "data", "processed", "charging_clean.parquet"),
        help="Output Parquet path",
    )
    args = parser.parse_args()
    run(args.src, args.out)


if __name__ == "__main__":
    main()
