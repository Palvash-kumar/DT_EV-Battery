#!/usr/bin/env python3
"""
evaluate_models.py — Generate evaluation report and plots for both models.

Reads the residual .npz files and metadata JSONs saved by train_duration.py
and train_energy.py. Produces:
  - Residual plots (actual vs predicted, residual distribution)
  - Subgroup MAE bar charts (by charger type, vehicle model)
  - A combined metrics summary printed to stdout

Usage:
    cd laptop-2
    source .venv/bin/activate
    python src/evaluate_models.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

MODELS_DIR = Path(os.path.dirname(__file__)) / ".." / "models"
PLOTS_DIR = MODELS_DIR / "plots"


def load_residuals(task: str) -> dict:
    npz_path = MODELS_DIR / f"{task}_residuals.npz"
    meta_path = MODELS_DIR / f"{task}_model_metadata.json"
    data = dict(np.load(npz_path, allow_pickle=True))
    with open(meta_path) as f:
        meta = json.load(f)
    return {**data, "meta": meta}


def plot_actual_vs_predicted(y_test, y_pred, task_label: str, units: str, out_path: Path):
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))

    # Scatter: actual vs predicted
    ax = axes[0]
    ax.scatter(y_test, y_pred, alpha=0.4, s=15, edgecolors="none")
    lo = min(y_test.min(), y_pred.min())
    hi = max(y_test.max(), y_pred.max())
    ax.plot([lo, hi], [lo, hi], "r--", linewidth=1, label="Perfect prediction")
    ax.set_xlabel(f"Actual ({units})")
    ax.set_ylabel(f"Predicted ({units})")
    ax.set_title(f"{task_label} — Actual vs Predicted")
    ax.legend()

    # Histogram: residuals
    ax = axes[1]
    residuals = y_test - y_pred
    ax.hist(residuals, bins=30, edgecolor="black", alpha=0.7)
    ax.axvline(0, color="red", linestyle="--", linewidth=1)
    ax.set_xlabel(f"Residual ({units})")
    ax.set_ylabel("Count")
    ax.set_title(f"{task_label} — Residual Distribution")

    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    print(f"  Saved {out_path}")


def plot_subgroup_errors(subgroup_errors: dict, task_label: str, units: str, out_path: Path):
    n_groups = len(subgroup_errors)
    fig, axes = plt.subplots(1, n_groups, figsize=(6 * n_groups, 5))
    if n_groups == 1:
        axes = [axes]

    for ax, (group_name, sg) in zip(axes, subgroup_errors.items()):
        labels = list(sg.keys())
        maes = [sg[k]["mae"] for k in labels]
        counts = [sg[k]["count"] for k in labels]

        bars = ax.bar(labels, maes, edgecolor="black", alpha=0.8)
        # Add count annotations
        for bar, cnt in zip(bars, counts):
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height() + 0.01,
                    f"n={cnt}", ha="center", va="bottom", fontsize=8)
        ax.set_ylabel(f"MAE ({units})")
        ax.set_title(f"{task_label} — MAE by {group_name}")
        ax.tick_params(axis="x", rotation=30)

    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    print(f"  Saved {out_path}")


def print_summary(meta: dict):
    print(f"\n{'='*60}")
    print(f"  {meta['task']}")
    print(f"  Target: {meta['target']} ({meta['target_units']})")
    print(f"  Selected model: {meta['selected_model']}")
    print(f"  Train/Test split: {meta['train_rows']} / {meta['test_rows']}")
    print(f"{'='*60}")
    print(f"  {'Model':<30s} {'CV-MAE':>8s} {'Test MAE':>9s} {'RMSE':>8s} {'R²':>8s}")
    print(f"  {'-'*55}")
    for name, r in meta["all_results"].items():
        marker = " ✓" if name == meta["selected_model"] else ""
        print(f"  {name:<30s} {r['cv_mae']:>8.4f} {r['test_mae']:>9.4f} {r['test_rmse']:>8.4f} {r['test_r2']:>8.4f}{marker}")
    print()
    print("  Limitations:")
    for lim in meta["limitations"]:
        print(f"    • {lim}")
    print()


def main():
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    for task, label, units in [
        ("duration", "Charging Duration", "hours"),
        ("energy", "Energy Consumed", "kWh"),
    ]:
        d = load_residuals(task)
        meta = d["meta"]

        print_summary(meta)

        y_test = d["y_test"]
        y_pred = d["y_pred"]

        plot_actual_vs_predicted(
            y_test, y_pred, label, units,
            PLOTS_DIR / f"{task}_actual_vs_predicted.png",
        )
        plot_subgroup_errors(
            meta["subgroup_errors"], label, units,
            PLOTS_DIR / f"{task}_subgroup_mae.png",
        )

    print("\n✅ All evaluation plots saved to", PLOTS_DIR)


if __name__ == "__main__":
    main()
