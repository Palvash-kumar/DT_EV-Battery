#!/usr/bin/env python3
"""
03_battery_aging.py — EDA and evaluation plots for battery aging data and models.

Generates:
  1. Per-battery capacity fade curves
  2. SOH distribution across batteries
  3. SOH model: actual vs predicted + per-battery errors
  4. RUL model: actual vs predicted + per-battery errors

Usage:
    cd laptop-2
    source .venv/bin/activate
    python notebooks/03_battery_aging.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

BASE = Path(os.path.dirname(__file__)) / ".."
DATA_PATH = BASE / "data" / "battery_aging" / "processed" / "aging_normalized.parquet"
MODELS_DIR = BASE / "models"
PLOTS_DIR = BASE / "data" / "battery_aging" / "processed" / "plots"


def plot_capacity_fade(df: pd.DataFrame):
    """Per-battery capacity fade curves."""
    fig, axes = plt.subplots(1, 2, figsize=(14, 5))

    # Capacity vs cycle
    ax = axes[0]
    for bat_id, group in df.groupby("battery_id"):
        ax.plot(group["cycle"], group["discharge_capacity_ah"], label=bat_id, linewidth=1)
    ax.set_xlabel("Cycle Number")
    ax.set_ylabel("Discharge Capacity (Ah)")
    ax.set_title("Capacity Fade per Battery")
    ax.legend(fontsize=7)
    ax.grid(True, alpha=0.3)

    # SOH vs cycle
    ax = axes[1]
    for bat_id, group in df.groupby("battery_id"):
        ax.plot(group["cycle"], group["soh_pct"], label=bat_id, linewidth=1)
    ax.axhline(80, color="red", linestyle="--", linewidth=1, label="EOL (80%)")
    ax.set_xlabel("Cycle Number")
    ax.set_ylabel("SOH (%)")
    ax.set_title("State of Health per Battery")
    ax.legend(fontsize=7)
    ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "01_capacity_fade_curves.png", dpi=150)
    plt.close(fig)
    print(f"  Saved 01_capacity_fade_curves.png")


def plot_soh_distribution(df: pd.DataFrame):
    """SOH distribution and battery-level summary."""
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))

    ax = axes[0]
    ax.hist(df["soh_pct"], bins=40, edgecolor="black", alpha=0.7)
    ax.axvline(80, color="red", linestyle="--", label="EOL threshold (80%)")
    ax.set_xlabel("SOH (%)")
    ax.set_ylabel("Count")
    ax.set_title("SOH Distribution (All Cycles)")
    ax.legend()

    ax = axes[1]
    summary = df.groupby("battery_id").agg(
        min_soh=("soh_pct", "min"),
        max_soh=("soh_pct", "max"),
        total_cycles=("cycle", "max"),
    ).sort_values("total_cycles")
    bars = ax.barh(summary.index, summary["total_cycles"], edgecolor="black", alpha=0.8)
    for bar, min_soh in zip(bars, summary["min_soh"]):
        color = "red" if min_soh <= 80 else "green"
        bar.set_color(color)
    ax.set_xlabel("Total Cycles")
    ax.set_title("Cycles per Battery (red = reached EOL)")

    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "02_soh_distribution.png", dpi=150)
    plt.close(fig)
    print(f"  Saved 02_soh_distribution.png")


def plot_model_evaluation(task: str, label: str, units: str):
    """Actual vs predicted and per-battery errors for a model."""
    npz_path = MODELS_DIR / f"{task}_residuals.npz"
    meta_path = MODELS_DIR / f"{task}_model_metadata.json"

    if not npz_path.exists():
        print(f"  ⚠️  {npz_path} not found, skipping {task} plots")
        return

    data = dict(np.load(npz_path, allow_pickle=True))
    with open(meta_path) as f:
        meta = json.load(f)

    y_test = data["y_test"]
    y_pred = data["y_pred"]
    battery_ids = data["battery_id"]

    fig, axes = plt.subplots(1, 3, figsize=(18, 5))

    # 1. Actual vs Predicted scatter
    ax = axes[0]
    # Color by battery
    unique_bats = np.unique(battery_ids)
    colors = plt.cm.tab10(np.linspace(0, 1, len(unique_bats)))
    for bat, color in zip(unique_bats, colors):
        mask = battery_ids == bat
        ax.scatter(y_test[mask], y_pred[mask], alpha=0.4, s=10, color=color, label=bat)
    lo = min(y_test.min(), y_pred.min())
    hi = max(y_test.max(), y_pred.max())
    ax.plot([lo, hi], [lo, hi], "r--", linewidth=1)
    ax.set_xlabel(f"Actual ({units})")
    ax.set_ylabel(f"Predicted ({units})")
    ax.set_title(f"{label} — Actual vs Predicted")
    ax.legend(fontsize=7)

    # 2. Residual distribution
    ax = axes[1]
    residuals = y_test - y_pred
    ax.hist(residuals, bins=30, edgecolor="black", alpha=0.7)
    ax.axvline(0, color="red", linestyle="--")
    ax.set_xlabel(f"Residual ({units})")
    ax.set_ylabel("Count")
    ax.set_title(f"{label} — Residuals")

    # 3. Per-battery MAE
    ax = axes[2]
    per_bat = meta.get("per_battery_errors", {})
    if per_bat:
        bats = list(per_bat.keys())
        maes = [per_bat[b]["mae"] for b in bats]
        ax.bar(bats, maes, edgecolor="black", alpha=0.8)
        ax.set_ylabel(f"MAE ({units})")
        ax.set_title(f"{label} — MAE per Test Battery")
        ax.tick_params(axis="x", rotation=30)

    fig.tight_layout()
    fig.savefig(PLOTS_DIR / f"03_{task}_evaluation.png", dpi=150)
    plt.close(fig)
    print(f"  Saved 03_{task}_evaluation.png")


def plot_rul_vs_cycle(task: str = "rul"):
    """RUL predictions vs cycle number for test batteries."""
    npz_path = MODELS_DIR / f"{task}_residuals.npz"
    if not npz_path.exists():
        return

    data = dict(np.load(npz_path, allow_pickle=True))
    cycles = data["cycle"]
    y_test = data["y_test"]
    y_pred = data["y_pred"]
    battery_ids = data["battery_id"]

    unique_bats = np.unique(battery_ids)
    n = len(unique_bats)
    fig, axes = plt.subplots(1, n, figsize=(6 * n, 4), squeeze=False)

    for i, bat in enumerate(unique_bats):
        ax = axes[0, i]
        mask = battery_ids == bat
        ax.plot(cycles[mask], y_test[mask], "b-", label="Actual RUL", linewidth=1)
        ax.plot(cycles[mask], y_pred[mask], "r--", label="Predicted RUL", linewidth=1)
        ax.set_xlabel("Cycle")
        ax.set_ylabel("RUL (cycles)")
        ax.set_title(f"{bat} — RUL")
        ax.legend(fontsize=8)
        ax.grid(True, alpha=0.3)

    fig.tight_layout()
    fig.savefig(PLOTS_DIR / "04_rul_vs_cycle.png", dpi=150)
    plt.close(fig)
    print(f"  Saved 04_rul_vs_cycle.png")


def main():
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    if not DATA_PATH.exists():
        print(f"❌ {DATA_PATH} not found. Run prepare_aging_data.py first.")
        return

    df = pd.read_parquet(DATA_PATH)
    print(f"\nBattery aging dataset: {len(df)} rows, {df['battery_id'].nunique()} batteries")
    print(f"SOH range: {df['soh_pct'].min():.1f}% — {df['soh_pct'].max():.1f}%\n")

    # Per-battery summary
    print("  Per-battery summary:")
    for bat_id, group in df.groupby("battery_id"):
        print(f"    {bat_id}: {len(group)} cycles, SOH {group['soh_pct'].max():.1f}% → {group['soh_pct'].min():.1f}%")
    print()

    plot_capacity_fade(df)
    plot_soh_distribution(df)
    plot_model_evaluation("soh", "SOH Prediction", "SOH %")
    plot_model_evaluation("rul", "RUL Prediction", "cycles")
    plot_rul_vs_cycle()

    print(f"\n✅ All plots saved to {PLOTS_DIR}")


if __name__ == "__main__":
    main()
