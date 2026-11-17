#!/usr/bin/env python3
"""
train_rul.py — Train a Remaining Useful Life (RUL) prediction model.

Target: rul_cycles (cycles remaining until SOH drops to EOL threshold)
Features: cycle, soh_pct, temperature_c, charge/discharge rate, DOD,
          capacity_loss_ah
Split: by battery_id (never random rows)

Usage:
    cd laptop-2
    source .venv/bin/activate
    python src/train_rul.py
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
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import LinearRegression
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
import joblib

# ---------------------------------------------------------------------------
# Feature contract — what we know at any point during battery life
# ---------------------------------------------------------------------------
FEATURES = [
    "cycle",
    "soh_pct",           # current measured SOH — the key input
    "capacity_loss_ah",  # how much capacity has been lost so far
    "temperature_c",
    "charge_rate_c",
    "discharge_rate_c",
    "dod_pct",
]

TARGET = "rul_cycles"


def load_data(path: str | Path) -> pd.DataFrame:
    df = pd.read_parquet(path)
    required = FEATURES + [TARGET, "battery_id"]
    missing = set(required) - set(df.columns)
    if missing:
        sys.exit(f"Missing columns: {missing}")
    # Drop rows where RUL is NaN (batteries that never reach EOL — can't train on them)
    before = len(df)
    df = df.dropna(subset=[TARGET])
    after = len(df)
    if before != after:
        print(f"  Dropped {before - after} rows with NaN RUL ({after} remain)")
    return df


def build_preprocessor() -> ColumnTransformer:
    return ColumnTransformer([
        ("num", Pipeline([
            ("imputer", SimpleImputer(strategy="median")),
            ("scaler", StandardScaler()),
        ]), FEATURES),
    ])


def train(data_path: str | Path, out_path: str | Path, seed: int = 42) -> dict:
    data_path = Path(data_path)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    df = load_data(data_path)
    batteries = sorted(df["battery_id"].unique())

    # --- Split by battery ID ---
    n_train = max(1, int(len(batteries) * 0.75))
    rng = np.random.default_rng(seed)
    rng.shuffle(batteries)
    train_bats = batteries[:n_train]
    test_bats = batteries[n_train:]

    print(f"  Train batteries ({len(train_bats)}): {train_bats}")
    print(f"  Test batteries  ({len(test_bats)}):  {test_bats}")

    train_mask = df["battery_id"].isin(train_bats)
    test_mask = df["battery_id"].isin(test_bats)

    X_train, y_train = df.loc[train_mask, FEATURES], df.loc[train_mask, TARGET]
    X_test, y_test = df.loc[test_mask, FEATURES], df.loc[test_mask, TARGET]

    preprocessor = build_preprocessor()

    candidates = {
        "LinearRegression": Pipeline([
            ("prep", preprocessor),
            ("model", LinearRegression()),
        ]),
        "RandomForest": Pipeline([
            ("prep", preprocessor),
            ("model", RandomForestRegressor(
                n_estimators=200, max_depth=15, random_state=seed, n_jobs=-1,
            )),
        ]),
        "HistGradientBoosting": Pipeline([
            ("prep", preprocessor),
            ("model", HistGradientBoostingRegressor(
                max_iter=300, max_depth=8, random_state=seed,
            )),
        ]),
    }

    results: dict[str, dict] = {}
    for name, pipe in candidates.items():
        pipe.fit(X_train, y_train)
        y_pred = pipe.predict(X_test)

        mae = mean_absolute_error(y_test, y_pred)
        rmse = np.sqrt(mean_squared_error(y_test, y_pred))
        r2 = r2_score(y_test, y_pred)

        results[name] = {
            "test_mae": round(float(mae), 4),
            "test_rmse": round(float(rmse), 4),
            "test_r2": round(float(r2), 4),
        }
        print(f"  {name:30s}  MAE={mae:.1f} cycles  RMSE={rmse:.1f}  R²={r2:.4f}")

    best_name = min(results, key=lambda k: results[k]["test_mae"])
    best_pipe = candidates[best_name]

    # Per-battery test errors
    y_pred_test = best_pipe.predict(X_test)
    per_battery_errors: dict[str, dict] = {}
    for bat in test_bats:
        mask = df.loc[test_mask, "battery_id"] == bat
        if mask.sum() == 0:
            continue
        per_battery_errors[bat] = {
            "count": int(mask.sum()),
            "mae": round(float(mean_absolute_error(y_test[mask], y_pred_test[mask])), 1),
            "rmse": round(float(np.sqrt(mean_squared_error(y_test[mask], y_pred_test[mask]))), 1),
        }

    # Save
    joblib.dump(best_pipe, out_path)

    residuals_path = out_path.parent / "rul_residuals.npz"
    np.savez(
        residuals_path,
        y_test=np.array(y_test),
        y_pred=y_pred_test,
        cycle=np.array(X_test["cycle"]),
        soh_pct=np.array(X_test["soh_pct"]),
        battery_id=np.array(df.loc[test_mask, "battery_id"]),
    )

    metadata = {
        "task": "battery_rul_prediction",
        "target": TARGET,
        "target_units": "cycles to EOL",
        "eol_threshold_soh_pct": 80.0,
        "features": FEATURES,
        "selected_model": best_name,
        "all_results": results,
        "per_battery_errors": per_battery_errors,
        "train_batteries": train_bats,
        "test_batteries": test_bats,
        "train_rows": int(train_mask.sum()),
        "test_rows": int(test_mask.sum()),
        "split": "By battery ID (75/25), never random rows",
        "training_date": datetime.now(timezone.utc).isoformat(),
        "dataset_version": str(data_path),
        "limitations": [
            "RUL is estimated as cycles until SOH ≤ 80% — threshold is a configurable assumption.",
            "Model trained on lab cycling data (single chemistry, controlled conditions).",
            "RUL predictions are model estimates, not certified battery lifetime guarantees.",
            "Real EV batteries face variable conditions (temperature, charge patterns, calendar aging).",
            "Lab-to-field transfer requires calibration with real vehicle data.",
            "Batteries that never reached EOL in test data have extrapolated RUL labels.",
        ],
    }

    meta_path = out_path.parent / "rul_model_metadata.json"
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"\n✅ Selected: {best_name}")
    print(f"✅ Pipeline saved to {out_path}")
    print(f"✅ Metadata saved to {meta_path}")
    return metadata


def main():
    parser = argparse.ArgumentParser(description="Train battery RUL model")
    parser.add_argument(
        "--data",
        default=os.path.join(os.path.dirname(__file__), "..", "data", "battery_aging", "processed", "aging_normalized.parquet"),
    )
    parser.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(__file__), "..", "models", "rul.joblib"),
    )
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    train(args.data, args.out, seed=args.seed)


if __name__ == "__main__":
    main()
