#!/usr/bin/env python3
"""
prepare_isu.py — ISU-ILCC battery aging data -> one row per capacity check (RPT).

For each of the 251 NMC/graphite cells (250 mAh, cycled at 30 °C) this pairs
the C/5 capacity measured at every reference performance test with the exact
charge throughput before it, from the raw cycling files:

  efc   equivalent full cycles = cumulative discharged Ah / rated 0.25 Ah
  retention_pct = capacity / capacity at the first RPT × 100

Test conditions per group come from Table A1 of the dataset README.

Also writes one row per cell with its life: EFC at which retention first fell
to 80 % (linear interpolation between RPTs).

Usage:
    cd laptop-2
    python src/download_datasets.py isu isu-raw
    python src/prepare_isu.py
"""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "battery_aging" / "raw" / "isu_ilcc"
OUT_DIR = ROOT / "data" / "battery_aging" / "processed"
RATED_AH = 0.25
EOL_RETENTION = 80.0

# Table A1: group -> (charge C-rate, discharge C-rate, mean depth of discharge %)
CONDITIONS = {
    1: (0.5, 0.5, 25.90), 2: (0.5, 0.5, 46.11), 3: (0.5, 0.5, 67.77), 4: (1.0, 0.5, 47.27),
    5: (1.0, 0.5, 97.54), 6: (2.0, 0.5, 27.23), 7: (2.0, 0.5, 46.86), 8: (2.0, 0.5, 67.24),
    9: (2.0, 0.5, 96.93), 10: (2.5, 0.5, 47.21), 11: (2.5, 0.5, 95.98), 12: (3.0, 0.5, 28.60),
    13: (3.0, 0.5, 47.26), 14: (3.0, 0.5, 66.32), 16: (0.5, 0.5, 97.62), 17: (1.0, 0.5, 67.53),
    18: (2.5, 0.5, 27.53), 19: (2.5, 0.5, 65.70), 20: (0.8, 0.5, 98.16), 21: (1.2, 0.5, 97.98),
    22: (1.4, 0.5, 97.88), 23: (1.6, 0.5, 97.61), 24: (1.8, 0.5, 97.51), 25: (1.8, 0.6, 51.43),
    26: (1.4, 2.2, 4.16), 27: (0.6, 2.4, 57.85), 28: (2.4, 1.6, 80.99), 29: (1.6, 1.8, 52.48),
    30: (0.8, 0.8, 77.59), 31: (1.2, 1.0, 61.43), 32: (1.0, 1.4, 38.86), 33: (2.0, 1.2, 40.65),
    34: (2.2, 2.0, 27.60), 35: (1.825, 0.5, 97.02), 36: (2.075, 0.5, 97.06), 37: (0.725, 0.5, 98.08),
    38: (1.875, 0.5, 95.83), 39: (1.475, 0.5, 97.14), 40: (1.825, 1.025, 31.94), 41: (2.075, 1.775, 67.02),
    42: (0.725, 2.375, 36.32), 43: (1.875, 2.325, 38.00), 44: (0.775, 1.275, 37.12), 45: (1.125, 1.725, 80.26),
    46: (1.225, 2.025, 75.36), 47: (2.325, 1.925, 48.27), 48: (2.375, 2.225, 58.57), 49: (0.975, 0.675, 18.82),
    50: (2.425, 1.625, 20.10), 51: (2.275, 1.875, 53.64), 52: (1.425, 0.875, 83.55), 53: (2.025, 0.825, 91.54),
    54: (0.925, 1.125, 27.05), 55: (1.025, 2.475, 61.44), 56: (2.175, 0.975, 53.81), 57: (1.775, 1.175, 17.42),
    58: (2.475, 0.575, 42.03), 59: (1.325, 1.825, 31.64), 60: (0.675, 1.325, 83.63), 61: (2.125, 1.975, 54.07),
    62: (1.575, 2.425, 64.19), 63: (1.975, 1.675, 80.57), 64: (1.175, 1.425, 91.44),
}
RPT_WEEKS_GUESS = 0.1  # an RPT takes roughly 17 h; only used to line RPTs up with cycling blocks


def _decode_keys(text: str, keys: tuple[str, ...]) -> dict:
    """Decode only the named top-level values; the per-cycle voltage curves make up most of each file."""
    decoder, out = json.JSONDecoder(), {}
    for key in keys:
        start = text.index(f'"{key}":') + len(key) + 3
        while text[start] == " ":
            start += 1
        out[key], _ = decoder.raw_decode(text, start)
    return out


def cycling_blocks(z: zipfile.ZipFile, member: str) -> pd.DataFrame:
    """Per weekly cycling block: duration in weeks and discharged Ah."""
    d = _decode_keys(json.loads(z.read(member)),
                     ("capacity_discharge", "start_stop_time", "time_series_discharge"))
    starts = pd.to_datetime(pd.Series(d["start_stop_time"]["start"]).replace("[]", None))
    stops = pd.to_datetime(pd.Series(d["start_stop_time"]["stop"]).replace("[]", None))
    cyc_start = pd.to_datetime(pd.Series(d["time_series_discharge"]["start"]).replace("[]", None))
    cap = pd.to_numeric(pd.Series(d["capacity_discharge"]).map(lambda c: np.nan if isinstance(c, list) else c))
    rows = []
    for b, (s, e) in enumerate(zip(starts, stops)):
        if pd.isna(s):
            rows.append({"block": b, "weeks": np.nan, "ah": np.nan, "cycles": np.nan})
            continue
        in_block = (cyc_start >= s) & (cyc_start <= e)
        rows.append({"block": b, "weeks": (e - s) / pd.Timedelta(weeks=1),
                     "ah": float(cap[in_block].sum()), "cycles": int(in_block.sum())})
    blocks = pd.DataFrame(rows)
    # Blocks with lost data (README A2): assume they match their neighbours
    for col in ("weeks", "ah", "cycles"):
        blocks[col] = blocks[col].interpolate(limit_direction="both")
    return blocks


def align(fade: pd.DataFrame, blocks: pd.DataFrame) -> pd.DataFrame:
    """Attach cumulative Ah to each RPT row of capacity_fade (some RPTs are missing)."""
    cum_weeks = np.concatenate([[0.0], blocks["weeks"].cumsum().to_numpy()])
    cum_ah = np.concatenate([[0.0], blocks["ah"].cumsum().to_numpy()])
    cum_cycles = np.concatenate([[0.0], blocks["cycles"].cumsum().to_numpy()])
    expected = cum_weeks + RPT_WEEKS_GUESS * np.arange(len(cum_weeks))
    idx = np.abs(fade["Time"].to_numpy()[:, None] - expected[None, :]).argmin(axis=1)
    return fade.assign(rpt=idx, efc=cum_ah[idx] / RATED_AH, cycles=cum_cycles[idx])


def life_efc(cell: pd.DataFrame) -> float:
    r, e = cell["retention_pct"].to_numpy(), cell["efc"].to_numpy()
    below = np.flatnonzero(r <= EOL_RETENTION)
    if not len(below) or below[0] == 0:
        return np.nan
    i = below[0]
    return float(np.interp(EOL_RETENTION, [r[i], r[i - 1]], [e[i], e[i - 1]]))


def main():
    cells = pd.read_csv(RAW / "Valid_cells.csv")["Cell"].tolist()
    fade_files = {p.stem: p for p in sorted((RAW / "capacity_fade").rglob("*.csv"))}  # Release 2.0 sorts last and wins
    rows = []
    with zipfile.ZipFile(RAW / "Cycling_json.zip") as z:
        members = {Path(n).stem: n for n in sorted(z.namelist()) if n.endswith(".json")}
        for cell in sorted(set(fade_files) & set(members)):
            group = int(cell[1:cell.index("C")])
            fade = pd.read_csv(fade_files[cell])
            aligned = align(fade, cycling_blocks(z, members[cell]))
            cc, cd, dod = CONDITIONS[group]
            aligned = aligned.assign(cell=cell, group=group, charge_c=cc, discharge_c=cd, dod_pct=dod,
                                     capacity_ah=aligned["Capacity"], time_weeks=aligned["Time"],
                                     retention_pct=aligned["Capacity"] / aligned["Capacity"].iloc[0] * 100)
            rows.append(aligned.drop(columns=["Time", "Capacity"]))
    df = pd.concat(rows, ignore_index=True)
    lives = (df.groupby("cell").apply(life_efc, include_groups=False).rename("life_efc").reset_index()
             .merge(df.groupby("cell")[["group", "charge_c", "discharge_c", "dod_pct"]].first().reset_index()))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT_DIR / "isu_rpt.parquet", index=False)
    lives.to_parquet(OUT_DIR / "isu_life.parquet", index=False)
    summary = {
        "source": "ISU-ILCC Battery Aging Dataset (Li et al. 2023), CC BY 4.0, doi:10.25380/iastate.22582234",
        "cells": int(df["cell"].nunique()), "groups": int(df["group"].nunique()), "rpt_rows": int(len(df)),
        "cells_reaching_80pct": int(lives["life_efc"].notna().sum()),
        "not_in_release": sorted(set(cells) - set(df["cell"])),
        "life_efc": lives["life_efc"].describe().round(1).to_dict(),
    }
    (OUT_DIR / "isu_summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
