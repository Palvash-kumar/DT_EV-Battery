#!/usr/bin/env python3
"""
prepare_sessions.py — Combine real charging sessions into one clean table.

Sources
  Palo Alto  City of Palo Alto public chargers, 2011-2020 (Level 1/2, with fees)
  ACN-Data   Caltech, JPL and an office site (Level 2, managed charging)

Unified columns: dataset, user_key, station, start_local, hour, weekday, month,
year, port_type, energy_kwh, charge_h, plug_h, idle_h, fee_usd, power_kw,
vehicle_power_kw.

vehicle_power_kw estimates the car's own charging limit: the 90th percentile of
average power over the driver's *other* sessions (leave-one-out), so the
feature never contains the session it is used to predict.

Usage:
    cd laptop-2
    python src/prepare_sessions.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "charging_sessions" / "raw"
OUT = ROOT / "data" / "charging_sessions" / "processed" / "sessions.parquet"

MIN_USER_SESSIONS = 4
EXACT_LOO_BELOW = 50  # above this many sessions one session cannot move the P90


def _hours(s: pd.Series) -> pd.Series:
    return pd.to_timedelta(s, errors="coerce").dt.total_seconds() / 3600


def load_palo_alto() -> pd.DataFrame:
    d = pd.read_csv(RAW / "palo_alto_ev_usage.csv", encoding="utf-8-sig", low_memory=False)
    d = d[d["Currency"].fillna("USD") == "USD"]
    start = pd.to_datetime(d["Start Date"], format="mixed")
    return pd.DataFrame({
        "dataset": "palo_alto",
        "user_key": ("pa_" + d["User ID"].astype(str).str.strip()).where(d["User ID"].notna()),
        "station": d["Station Name"].str.strip(),
        "start_local": start,
        "port_type": d["Port Type"],
        "energy_kwh": d["Energy (kWh)"],
        "charge_h": _hours(d["Charging Time (hh:mm:ss)"]),
        "plug_h": _hours(d["Total Duration (hh:mm:ss)"]),
        # Palo Alto started charging for energy in mid-2017; earlier sessions were free
        "fee_usd": d["Fee"].where(start >= "2017-08-01"),
    })


def load_acn() -> pd.DataFrame:
    frames = []
    for path in sorted(RAW.glob("acn_*.json")):
        items = json.loads(path.read_text())
        d = pd.DataFrame(items)
        conn = pd.to_datetime(d["connectionTime"], format="%a, %d %b %Y %H:%M:%S %Z", utc=True)
        done = pd.to_datetime(d["doneChargingTime"], format="%a, %d %b %Y %H:%M:%S %Z", utc=True, errors="coerce")
        disc = pd.to_datetime(d["disconnectTime"], format="%a, %d %b %Y %H:%M:%S %Z", utc=True, errors="coerce")
        frames.append(pd.DataFrame({
            "dataset": "acn_" + path.stem.removeprefix("acn_"),
            "user_key": ("acn_" + d["userID"].astype(str)).where(d["userID"].notna()),
            "station": d["stationID"],
            "start_local": conn.dt.tz_convert("America/Los_Angeles").dt.tz_localize(None),
            "port_type": "Level 2",
            "energy_kwh": d["kWhDelivered"],
            "charge_h": (done - conn).dt.total_seconds() / 3600,
            "plug_h": (disc - conn).dt.total_seconds() / 3600,
            "fee_usd": np.nan,
        }))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def clean(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    report = {"raw_rows": int(len(df))}
    df = df.copy()
    df["power_kw"] = df["energy_kwh"] / df["charge_h"]
    max_kw = np.where(df["port_type"] == "Level 1", 2.5, 19.2)
    rules = {
        "missing_values": df[["energy_kwh", "charge_h", "plug_h"]].isna().any(axis=1),
        "energy_below_0.5_or_above_100_kwh": ~df["energy_kwh"].between(0.5, 100),
        "charge_time_below_3_min": df["charge_h"] < 0.05,
        "plug_in_over_48_h": df["plug_h"] > 48,
        "charge_time_exceeds_plug_in_time": df["charge_h"] > df["plug_h"] + 0.05,
        "power_impossible_for_port": (df["power_kw"] < 0.3) | (df["power_kw"] > max_kw),
    }
    bad = np.zeros(len(df), dtype=bool)
    report["dropped_by_rule"] = {}
    for name, mask in rules.items():
        mask = mask.fillna(False).to_numpy()
        report["dropped_by_rule"][name] = int((mask & ~bad).sum())
        bad |= mask
    df = df[~bad].reset_index(drop=True)
    df["idle_h"] = (df["plug_h"] - df["charge_h"]).clip(lower=0)
    df["hour"] = df["start_local"].dt.hour
    df["weekday"] = df["start_local"].dt.weekday
    df["month"] = df["start_local"].dt.month
    df["year"] = df["start_local"].dt.year
    report["rows_after_cleaning"] = int(len(df))
    return df, report


def add_vehicle_power(df: pd.DataFrame) -> pd.DataFrame:
    out = np.full(len(df), np.nan)
    for _, idx in df.groupby("user_key").indices.items():
        if len(idx) < MIN_USER_SESSIONS:
            continue
        p = df["power_kw"].to_numpy()[idx]
        if len(idx) >= EXACT_LOO_BELOW:
            out[idx] = np.percentile(p, 90)
        else:
            out[idx] = [np.percentile(np.delete(p, i), 90) for i in range(len(p))]
    df["vehicle_power_kw"] = out
    return df


def main():
    parts = [load_palo_alto(), load_acn()]
    df = pd.concat([p for p in parts if len(p)], ignore_index=True)
    df, report = clean(df)
    df = add_vehicle_power(df)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    report["rows_by_dataset"] = df["dataset"].value_counts().to_dict()
    report["rows_with_vehicle_power"] = int(df["vehicle_power_kw"].notna().sum())
    (OUT.parent / "sessions_summary.json").write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps(report, indent=2, default=str))
    print(df.groupby("dataset")[["energy_kwh", "charge_h", "plug_h", "power_kw", "vehicle_power_kw"]].median().round(2))


if __name__ == "__main__":
    main()
