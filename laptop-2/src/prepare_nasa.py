#!/usr/bin/env python3
"""
prepare_nasa.py — Turn the NASA PCoE .mat files into one row per discharge cycle.

Each row pairs a discharge capacity (the SOH label) with features from the
charge that preceded it. Charge-curve features are what a charging station can
observe, so the SOH model can be used during a charging session:

  q_window_ah        Ah charged while voltage rose 3.9 V -> 4.19 V (CC phase)
  t_window_s         seconds that rise took
  cv_time_s          seconds spent in the constant-voltage phase
  charge_end_temp_c  cell temperature at end of charge

Conditions come from NASA's README files, not from guesses.

Usage:
    cd laptop-2
    python src/prepare_nasa.py
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.io import loadmat

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "battery_aging" / "raw" / "nasa_extracted"
OUT = ROOT / "data" / "battery_aging" / "processed" / "nasa_cycles.parquet"

RATED_AH = 2.0
V_LO, V_HI = 3.9, 4.19

# From the README of each NASA battery group: (ambient °C, discharge profile, cutoff V, EOL Ah)
CONDITIONS = {
    "B0005": (24, "2A CC", 2.7, 1.4), "B0006": (24, "2A CC", 2.5, 1.4),
    "B0007": (24, "2A CC", 2.2, 1.4), "B0018": (24, "2A CC", 2.5, 1.4),
    "B0025": (24, "4A square wave", 2.0, None), "B0026": (24, "4A square wave", 2.2, None),
    "B0027": (24, "4A square wave", 2.5, None), "B0028": (24, "4A square wave", 2.7, None),
    "B0029": (43, "4A CC", 2.0, None), "B0030": (43, "4A CC", 2.2, None),
    "B0031": (43, "4A CC", 2.5, None), "B0032": (43, "4A CC", 2.7, None),
    "B0033": (24, "4A CC", 2.0, 1.6), "B0034": (24, "4A CC", 2.2, 1.6), "B0036": (24, "2A CC", 2.7, 1.6),
    "B0038": (24, "1/2/4A mixed", 2.2, 1.6), "B0039": (24, "1/2/4A mixed", 2.5, 1.6),
    "B0040": (24, "1/2/4A mixed", 2.7, 1.6),
    "B0041": (4, "4A/1A mixed", 2.0, 1.4), "B0042": (4, "4A/1A mixed", 2.2, 1.4),
    "B0043": (4, "4A/1A mixed", 2.5, 1.4), "B0044": (4, "4A/1A mixed", 2.7, 1.4),
    "B0045": (4, "1A CC", 2.0, 1.4), "B0046": (4, "1A CC", 2.2, 1.4),
    "B0047": (4, "1A CC", 2.5, 1.4), "B0048": (4, "1A CC", 2.7, 1.4),
    "B0049": (4, "2A CC", 2.0, None), "B0050": (4, "2A CC", 2.2, None),
    "B0051": (4, "2A CC", 2.5, None), "B0052": (4, "2A CC", 2.7, None),
    "B0053": (4, "2A CC", 2.0, 1.4), "B0054": (4, "2A CC", 2.2, 1.4),
    "B0055": (4, "2A CC", 2.5, 1.4), "B0056": (4, "2A CC", 2.7, 1.4),
}


def charge_features(d: dict) -> dict | None:
    t, v, i, temp = (np.asarray(d[k], dtype=float) for k in
                     ("Time", "Voltage_measured", "Current_measured", "Temperature_measured"))
    if len(t) < 20:
        return None
    window = (v >= V_LO) & (v < V_HI) & (i > 1.0)
    if window.sum() < 3 or v[: max(1, np.argmax(window))].min() > V_LO:
        return None  # charge started above 3.9 V, the window is incomplete
    tw, iw = t[window], i[window]
    cv = np.flatnonzero(v >= V_HI)
    cv_time = float(t[-1] - t[cv[0]]) if len(cv) else np.nan
    return {
        "q_window_ah": float(np.trapezoid(iw, tw) / 3600),
        "t_window_s": float(tw[-1] - tw[0]),
        "cv_time_s": cv_time,
        "charge_end_temp_c": float(temp[-1]),
    }


def discharge_features(d: dict) -> dict:
    i, temp = np.asarray(d["Current_measured"], float), np.asarray(d["Temperature_measured"], float)
    loaded = i < -0.1
    return {
        "discharge_current_a": float(-i[loaded].mean()) if loaded.any() else np.nan,
        "discharge_max_temp_c": float(temp.max()),
    }


def load_battery(path: Path) -> pd.DataFrame:
    bat = path.stem
    ops = loadmat(str(path), simplify_cells=True)[bat]["cycle"]
    rows, last_charge, last_re, last_rct = [], None, np.nan, np.nan
    n_discharge = 0
    for op in ops:
        kind, data = op["type"], op["data"]
        if kind == "charge":
            last_charge = charge_features(data)
        elif kind == "impedance":
            re, rct = (np.ravel(np.real(data.get(k, np.nan))) for k in ("Re", "Rct"))
            if re.size == 1 and 0 < re[0] < 1:
                last_re = float(re[0])
            if rct.size == 1 and 0 < rct[0] < 1:
                last_rct = float(rct[0])
        elif kind == "discharge":
            n_discharge += 1
            cap_raw = np.ravel(np.real(data.get("Capacity", np.nan)))
            cap = float(cap_raw[0]) if cap_raw.size == 1 else np.nan
            rows.append({
                "battery_id": bat,
                "cycle": n_discharge,
                "ambient_temp_c": float(op["ambient_temperature"]),
                "capacity_ah": cap,
                "re_ohm": last_re,
                "rct_ohm": last_rct,
                **discharge_features(data),
                **(last_charge or {}),
            })
            last_charge = None
    return pd.DataFrame(rows)


def clean(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    report = {"raw_rows": len(df)}
    # The first charge of each battery followed storage and was partial
    df = df[df["cycle"] > 1]
    report["dropped_first_cycle"] = report["raw_rows"] - len(df)
    before = len(df)
    df = df[df["capacity_ah"].between(0.3, 2.3)].copy()
    report["dropped_capacity_out_of_range"] = before - len(df)

    # NASA's README notes "discharge runs where the capacity was very low" for
    # the 4 °C groups. Drop points far below the battery's local trend.
    trend = df.groupby("battery_id")["capacity_ah"].transform(
        lambda s: s.rolling(9, center=True, min_periods=3).median())
    glitch = (df["capacity_ah"] < trend - 0.08)
    report["dropped_low_capacity_glitches"] = int(glitch.sum())
    df = df[~glitch]

    before = len(df)
    df = df.dropna(subset=["q_window_ah", "t_window_s", "cv_time_s"])
    report["dropped_missing_charge_features"] = before - len(df)
    report["rows_after_cleaning"] = len(df)
    return df.reset_index(drop=True), report


def add_labels(df: pd.DataFrame) -> pd.DataFrame:
    df["soh_pct"] = df["capacity_ah"] / RATED_AH * 100
    df["eol_ah"] = df["battery_id"].map(lambda b: CONDITIONS[b][3])
    rul = np.full(len(df), np.nan)
    for bat, g in df.groupby("battery_id"):
        eol = CONDITIONS[bat][3]
        if eol is None:
            continue
        below = g.loc[g["capacity_ah"] <= eol, "cycle"]
        if below.empty:
            continue  # never reached end of life: RUL unknown (censored)
        eol_cycle = below.iloc[0]
        rul[g.index] = np.where(g["cycle"] <= eol_cycle, eol_cycle - g["cycle"], np.nan)
    df["rul_cycles"] = rul
    return df


def main():
    paths = {}
    for p in RAW.rglob("B00*.mat"):
        # Batteries 25-28 ship in two zips; keep the larger (more complete) file
        if p.stem not in paths or p.stat().st_size > paths[p.stem].stat().st_size:
            paths[p.stem] = p
    frames = [load_battery(p) for _, p in sorted(paths.items())]
    df = pd.concat(frames, ignore_index=True)
    for col, idx in (("cutoff_v", 2), ("discharge_profile", 1)):
        df[col] = df["battery_id"].map(lambda b: CONDITIONS[b][idx])
    df, report = clean(df)
    df = add_labels(df)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    summary = {
        "source": "NASA PCoE Battery Data Set (Saha & Goebel 2007), 34 LiCoO2 18650 cells",
        "rated_capacity_ah": RATED_AH,
        **report,
        "batteries": int(df["battery_id"].nunique()),
        "batteries_with_rul_labels": int(df.dropna(subset=["rul_cycles"])["battery_id"].nunique()),
        "cycles_per_battery": df.groupby("battery_id")["cycle"].max().to_dict(),
    }
    (OUT.parent / "nasa_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps({k: v for k, v in summary.items() if k != "cycles_per_battery"}, indent=2))
    print(df.groupby("battery_id").agg(cycles=("cycle", "max"), soh_first=("soh_pct", "first"),
                                       soh_last=("soh_pct", "last"), temp=("ambient_temp_c", "median"))
          .round(1).to_string())


if __name__ == "__main__":
    main()
