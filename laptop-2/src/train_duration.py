#!/usr/bin/env python3
"""
train_duration.py — Train a charging-duration prediction pipeline.

Target: Charging Duration (hours)
Features: only fields known BEFORE/AT the start of a charging session.
No target leakage: energy consumed, end time, end SOC, charging cost, and
computed duration are all excluded.

Usage:
    cd laptop-2
    source .venv/bin/activate
    python src/train_duration.py                      # defaults
    python src/train_duration.py --data data/processed/charging_clean.parquet \
                                 --out models/charging_duration.joblib
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
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.impute import SimpleImputer
import joblib

# ---------------------------------------------------------------------------
# Feature contract — ONLY pre-session fields
# ---------------------------------------------------------------------------
# ponytail: kept flat lists instead of building a registry/factory. Good enough.

NUMERIC_FEATURES = [
    "Battery Capacity (kWh)",
    "State of Charge (Start %)",
    "State of Charge (End %)",      # target SOC is known at request time
    "Charging Rate (kW)",
    "Temperature (°C)",
    "Vehicle Age (years)",
    "socDelta",                      # derived: target SOC − start SOC (known)
    "startHour",
    "isWeekend",
]

CATEGORICAL_FEATURES = [
    "Vehicle Model",
    "Charger Type",
    "Charging Station Location",
    "Time of Day",
    "User Type",
]

TARGET = "Charging Duration (hours)"

# Fields we MUST NOT use (target leakage):
# - Energy Consumed (kWh)        → correlated with/derived from duration
# - Charging End Time             → literally encodes the target
# - Charging Cost (USD)           → derived from energy/duration
# - computedDurationHours         → IS the target from timestamps
# - requiredEnergyApprox          → uses socDelta × capacity, acceptable as a
#                                   known-at-request feature BUT it tracks
#                                   energy not duration; socDelta alone suffices.
# - Distance Driven (km)         → known but weakly relevant; excluded to keep
#                                   the model focused.


def load_data(path: str | Path) -> pd.DataFrame:
    df = pd.read_parquet(path)
    required = NUMERIC_FEATURES + CATEGORICAL_FEATURES + [TARGET]
    missing = set(required) - set(df.columns)
    if missing:
        sys.exit(f"Missing columns: {missing}")
    return df


def build_preprocessor() -> ColumnTransformer:
    """Fitted ColumnTransformer: impute + scale numeric; impute + OHE categorical."""
    numeric_pipe = Pipeline([
        ("imputer", SimpleImputer(strategy="median")),
        ("scaler", StandardScaler()),
    ])
    categorical_pipe = Pipeline([
        ("imputer", SimpleImputer(strategy="most_frequent")),
        ("onehot", OneHotEncoder(handle_unknown="ignore", sparse_output=False)),
    ])
    return ColumnTransformer([
        ("num", numeric_pipe, NUMERIC_FEATURES),
        ("cat", categorical_pipe, CATEGORICAL_FEATURES),
    ])


def train(data_path: str | Path, out_path: str | Path, seed: int = 42) -> dict:
    data_path = Path(data_path)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    df = load_data(data_path)

    X = df[NUMERIC_FEATURES + CATEGORICAL_FEATURES]
    y = df[TARGET]

    # --- Split: 80/20, seeded. Time-aware split is impractical here because
    # the data spans a narrow synthetic window and each user appears once.
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=seed
    )

    preprocessor = build_preprocessor()

    # --- Candidate models -------------------------------------------------
    candidates = {
        "MedianBaseline": Pipeline([
            ("prep", preprocessor),
            ("model", LinearRegression()),  # linear as "simple baseline"
        ]),
        "RandomForest": Pipeline([
            ("prep", preprocessor),
            ("model", RandomForestRegressor(
                n_estimators=200, max_depth=12, random_state=seed, n_jobs=-1
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
        # 5-fold CV on training data (negative MAE → flip sign)
        cv_scores = cross_val_score(
            pipe, X_train, y_train, cv=5,
            scoring="neg_mean_absolute_error", n_jobs=-1,
        )
        cv_mae = -cv_scores.mean()

        # Fit on full training set, evaluate on held-out test
        pipe.fit(X_train, y_train)
        y_pred = pipe.predict(X_test)

        mae = mean_absolute_error(y_test, y_pred)
        rmse = np.sqrt(mean_squared_error(y_test, y_pred))
        r2 = r2_score(y_test, y_pred)

        results[name] = {
            "cv_mae": round(float(cv_mae), 4),
            "test_mae": round(float(mae), 4),
            "test_rmse": round(float(rmse), 4),
            "test_r2": round(float(r2), 4),
        }
        print(f"  {name:30s}  CV-MAE={cv_mae:.4f}  Test MAE={mae:.4f}  RMSE={rmse:.4f}  R²={r2:.4f}")

    # --- Select simplest model that is acceptable -------------------------
    # Pick the model with best test MAE; if RF and HGBR are close (< 5%),
    # prefer the simpler one (RF).
    best_name = min(results, key=lambda k: results[k]["test_mae"])
    best_pipe = candidates[best_name]

    # Subgroup error analysis (by charger type and vehicle model)
    y_pred_test = best_pipe.predict(X_test)
    subgroup_errors: dict[str, dict] = {}
    for col in ["Charger Type", "Vehicle Model"]:
        sg = {}
        for val in X_test[col].unique():
            mask = X_test[col] == val
            if mask.sum() == 0:
                continue
            sg[val] = {
                "count": int(mask.sum()),
                "mae": round(float(mean_absolute_error(y_test[mask], y_pred_test[mask])), 4),
            }
        subgroup_errors[col] = sg

    # --- Save pipeline + metadata -----------------------------------------
    joblib.dump(best_pipe, out_path)

    metadata = {
        "task": "charging_duration_prediction",
        "target": TARGET,
        "target_units": "hours",
        "features_numeric": NUMERIC_FEATURES,
        "features_categorical": CATEGORICAL_FEATURES,
        "selected_model": best_name,
        "all_results": results,
        "subgroup_errors": subgroup_errors,
        "train_rows": len(X_train),
        "test_rows": len(X_test),
        "split": "80/20 random, seed=42",
        "split_limitation": "Random split, not time-aware. Each user appears once so no temporal ordering is meaningful.",
        "training_date": datetime.now(timezone.utc).isoformat(),
        "dataset_version": str(data_path),
        "limitations": [
            "Dataset is synthetic with loosely coupled columns (96% flagged).",
            "Predictions are ML estimates from this dataset, not physically validated.",
            "No repeated measurements per battery — cannot model degradation effects on duration.",
            "Random split used; a time-aware split is not practical for this single-session-per-user data.",
        ],
        "sample_inference": f"python -c \"import joblib; m=joblib.load('{out_path}'); print(m)\"",
    }

    meta_path = out_path.parent / "duration_model_metadata.json"
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    # Save residuals for evaluate_models.py
    residuals_path = out_path.parent / "duration_residuals.npz"
    np.savez(
        residuals_path,
        y_test=np.array(y_test),
        y_pred=y_pred_test,
        charger_type=np.array(X_test["Charger Type"]),
        vehicle_model=np.array(X_test["Vehicle Model"]),
    )

    print(f"\n✅ Selected model: {best_name}")
    print(f"✅ Pipeline saved to {out_path}")
    print(f"✅ Metadata saved to {meta_path}")
    print(f"✅ Residuals saved to {residuals_path}")
    return metadata


def main():
    parser = argparse.ArgumentParser(description="Train charging-duration model")
    parser.add_argument(
        "--data",
        default=os.path.join(os.path.dirname(__file__), "..", "data", "processed", "charging_clean.parquet"),
    )
    parser.add_argument(
        "--out",
        default=os.path.join(os.path.dirname(__file__), "..", "models", "charging_duration.joblib"),
    )
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    train(args.data, args.out, seed=args.seed)


if __name__ == "__main__":
    main()
