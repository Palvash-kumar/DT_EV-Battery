#!/usr/bin/env python3
"""
study_ev_charging_patterns.py — Clean ev_charging_patterns.csv, train and cross-check
models for charging duration, energy consumed and charging cost.

Steps
  1. Preprocess: drop physically impossible rows, drop rows missing the target,
     engineer features known at request time (incl. physics-based estimates).
  2. Split 95 % train / 5 % test (seeded).
  3. 5-fold cross-validation on the 95 % to pick a model (never the test set).
  4. Refit on the 95 %, score once on the 5 %.
  5. Permutation test: retrain on shuffled targets. If real targets score no
     better than shuffled ones, the column holds no learnable signal.
  6. Score the physics estimator against the same labels.

Usage:
    cd laptop-2
    python src/study_ev_charging_patterns.py
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import KFold, cross_validate, permutation_test_score, train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ml_service"))
import charging_physics  # noqa: E402

SEED = 42
TEST_SIZE = 0.05

TARGETS = {
    "duration": ("Charging Duration (hours)", "hours", "durationHours"),
    "energy": ("Energy Consumed (kWh)", "kWh", "energyKwh"),
    "cost": ("Charging Cost (USD)", "USD", "costUsd"),
}

# Only fields the request contains, so training matches what the service receives
NUMERIC_FEATURES = [
    "Battery Capacity (kWh)",
    "State of Charge (Start %)",
    "State of Charge (End %)",
    "Charging Rate (kW)",
    "Temperature (°C)",
    "Vehicle Age (years)",
    "socDelta",
    "energyNeededKwh",
    "physicsDurationHours",
    "physicsEnergyKwh",
    "physicsCostUsd",
]
CATEGORICAL_FEATURES = ["Vehicle Model", "Charger Type"]


# ---------------------------------------------------------------------------
# Preprocessing
# ---------------------------------------------------------------------------

def clean(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    df = df.copy()
    for col in ["Vehicle Model", "Charger Type", "Charging Station Location", "User Type", "Time of Day"]:
        df[col] = df[col].str.strip()

    soc_s, soc_e = df["State of Charge (Start %)"], df["State of Charge (End %)"]
    rules = {
        "soc_outside_0_100": ~soc_s.between(0, 100) | ~soc_e.between(0, 100),
        "start_soc_not_below_end_soc": soc_s >= soc_e,
        "battery_capacity_outside_10_200_kwh": ~df["Battery Capacity (kWh)"].between(10, 200),
        "temperature_outside_minus30_50_c": ~df["Temperature (°C)"].between(-30, 50),
        "vehicle_age_outside_0_30": ~df["Vehicle Age (years)"].between(0, 30),
        "non_positive_duration_or_cost": (df["Charging Duration (hours)"] <= 0) | (df["Charging Cost (USD)"] <= 0),
    }
    bad = np.zeros(len(df), dtype=bool)
    report = {"raw_rows": len(df), "dropped_by_rule": {}}
    for name, mask in rules.items():
        mask = mask.fillna(False).to_numpy()
        report["dropped_by_rule"][name] = int((mask & ~bad).sum())
        bad |= mask
    df = df[~bad].reset_index(drop=True)
    report["rows_after_cleaning"] = len(df)

    df["socDelta"] = df["State of Charge (End %)"] - df["State of Charge (Start %)"]
    df["energyNeededKwh"] = df["Battery Capacity (kWh)"] * df["socDelta"] / 100

    # Missing charging rate (66 rows) is filled with the charger-type median only to
    # compute physics features; the model pipelines impute separately inside CV.
    rate = df["Charging Rate (kW)"].fillna(df.groupby("Charger Type")["Charging Rate (kW)"].transform("median"))
    phys = [
        charging_physics.estimate(
            vehicle_model=r["Vehicle Model"],
            battery_capacity_kwh=r["Battery Capacity (kWh)"],
            vehicle_age_years=r["Vehicle Age (years)"],
            start_soc_pct=r["State of Charge (Start %)"],
            target_soc_pct=r["State of Charge (End %)"],
            charger_type=r["Charger Type"],
            requested_rate_kw=rt,
            temperature_c=r["Temperature (°C)"],
        )
        for (_, r), rt in zip(df.iterrows(), rate)
    ]
    df["physicsDurationHours"] = [p["durationHours"] for p in phys]
    df["physicsEnergyKwh"] = [p["energyKwh"] for p in phys]
    df["physicsCostUsd"] = [p["costUsd"] for p in phys]
    return df, report


def target_rows(df: pd.DataFrame, key: str) -> pd.DataFrame:
    col = TARGETS[key][0]
    out = df.dropna(subset=[col])
    if key == "energy":
        # More energy than the whole pack can take (with charging losses) is impossible
        out = out[out[col] <= out["Battery Capacity (kWh)"] / 0.8]
    return out.reset_index(drop=True)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

def preprocessor() -> ColumnTransformer:
    return ColumnTransformer([
        ("num", Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler())]), NUMERIC_FEATURES),
        ("cat", OneHotEncoder(handle_unknown="ignore", sparse_output=False), CATEGORICAL_FEATURES),
    ])


def candidates() -> dict[str, Pipeline]:
    return {
        "MeanBaseline": Pipeline([("prep", preprocessor()), ("model", DummyRegressor(strategy="mean"))]),
        "Ridge": Pipeline([("prep", preprocessor()), ("model", Ridge(alpha=10.0))]),
        "RandomForest": Pipeline([("prep", preprocessor()), ("model", RandomForestRegressor(
            n_estimators=300, min_samples_leaf=5, random_state=SEED, n_jobs=-1))]),
        "HistGradientBoosting": Pipeline([("prep", preprocessor()), ("model", HistGradientBoostingRegressor(
            max_iter=200, learning_rate=0.05, max_depth=4, min_samples_leaf=20, random_state=SEED))]),
    }


def scores(y_true, y_pred) -> dict:
    return {
        "mae": round(float(mean_absolute_error(y_true, y_pred)), 4),
        "rmse": round(float(np.sqrt(mean_squared_error(y_true, y_pred))), 4),
        "r2": round(float(r2_score(y_true, y_pred)), 4),
    }


def train_target(df: pd.DataFrame, key: str, n_permutations: int) -> dict:
    col, units, physics_key = TARGETS[key]
    data = target_rows(df, key)
    X, y = data[NUMERIC_FEATURES + CATEGORICAL_FEATURES], data[col]
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=TEST_SIZE, random_state=SEED)
    cv = KFold(n_splits=5, shuffle=True, random_state=SEED)

    print(f"\n=== {col}  (train {len(X_train)}, test {len(X_test)}) ===")
    results = {}
    for name, pipe in candidates().items():
        cvr = cross_validate(pipe, X_train, y_train, cv=cv, n_jobs=-1,
                             scoring=("neg_mean_absolute_error", "r2"))
        pipe.fit(X_train, y_train)
        test = scores(y_test, pipe.predict(X_test))
        results[name] = {
            "cv_mae": round(float(-cvr["test_neg_mean_absolute_error"].mean()), 4),
            "cv_r2": round(float(cvr["test_r2"].mean()), 4),
            "test_mae": test["mae"], "test_rmse": test["rmse"], "test_r2": test["r2"],
            "prediction_spread_std": round(float(np.std(pipe.predict(X_test))), 4),
        }
        print(f"  {name:22s} CV MAE={results[name]['cv_mae']:.3f}  CV R²={results[name]['cv_r2']:+.3f}  "
              f"| test MAE={test['mae']:.3f}  R²={test['r2']:+.3f}")

    physics_test = scores(y_test, X_test[f"physics{physics_key[0].upper()}{physics_key[1:]}"])
    results["PhysicsEstimate"] = {"test_mae": physics_test["mae"], "test_rmse": physics_test["rmse"],
                                  "test_r2": physics_test["r2"]}
    print(f"  {'PhysicsEstimate':22s} (no training)            | test MAE={physics_test['mae']:.3f}  R²={physics_test['r2']:+.3f}")

    ml_names = [n for n in results if n not in ("MeanBaseline", "PhysicsEstimate")]
    best_ml = min(ml_names, key=lambda n: results[n]["cv_mae"])
    best_pipe = candidates()[best_ml]
    real_score, perm_scores, p_value = permutation_test_score(
        best_pipe, X_train, y_train, cv=cv, n_permutations=n_permutations,
        scoring="neg_mean_absolute_error", random_state=SEED, n_jobs=-1,
    )
    baseline_mae = results["MeanBaseline"]["cv_mae"]
    gain_pct = 100 * (baseline_mae - results[best_ml]["cv_mae"]) / baseline_mae
    # Significant AND large enough to matter: R² above 0.1 and at least 5 % lower MAE than the mean
    useful = p_value < 0.05 and results[best_ml]["cv_r2"] > 0.1 and gain_pct >= 5
    perm = {
        "model": best_ml,
        "cv_mae_real_targets": round(float(-real_score), 4),
        "cv_mae_shuffled_targets_mean": round(float(-perm_scores.mean()), 4),
        "p_value": round(float(p_value), 4),
        "mae_gain_over_mean_baseline_pct": round(float(gain_pct), 2),
        "has_useful_signal": bool(useful),
    }
    verdict = "USEFUL SIGNAL" if useful else (
        "NO USEFUL SIGNAL (statistically detectable but negligible)" if p_value < 0.05
        else "NO SIGNAL (labels behave like random noise)")
    print(f"  Permutation test ({best_ml}): real MAE={perm['cv_mae_real_targets']:.3f} vs shuffled "
          f"{perm['cv_mae_shuffled_targets_mean']:.3f}, p={perm['p_value']:.3f}, "
          f"gain over mean={gain_pct:.1f}% -> {verdict}")

    limitations = [
        "ev_charging_patterns.csv is synthetic: its target columns are statistically independent of every input "
        "(all correlations |r| < 0.07), so no model can learn them; see the permutation test.",
        "Physics estimates use approximate public figures (charger limits, vehicle specs, taper, prices), "
        "not measurements from this station.",
        f"The 5 % test set has only {len(X_test)} rows, so test scores swing a lot between seeds; CV scores on the "
        "95 % are the more reliable comparison.",
    ]
    return {
        "task": f"charging_{key}_prediction",
        "target": col,
        "target_units": units,
        "selected_model": "PhysicsEstimate",
        "best_ml_model": best_ml,
        "all_results": results,
        "permutation_test": perm,
        "features_numeric": NUMERIC_FEATURES,
        "features_categorical": CATEGORICAL_FEATURES,
        "train_rows": len(X_train),
        "test_rows": len(X_test),
        "split": f"95/5 random, seed={SEED}; model choice by 5-fold CV on the 95 %",
        "training_date": datetime.now(timezone.utc).isoformat(),
        "physics_version": charging_physics.VERSION,
        "limitations": limitations,
    }


def main():
    parser = argparse.ArgumentParser(description="Train and cross-check charging models")
    parser.add_argument("--src", default=str(ROOT.parent / "Data" / "ev_charging_patterns.csv"))
    parser.add_argument("--models-dir", default=str(ROOT / "models"))
    parser.add_argument("--permutations", type=int, default=100)
    args = parser.parse_args()

    models_dir = Path(args.models_dir)
    models_dir.mkdir(parents=True, exist_ok=True)

    raw = pd.read_csv(args.src)
    df, cleaning = clean(raw)
    print(f"Cleaning: {cleaning['raw_rows']} rows -> {cleaning['rows_after_cleaning']} rows")
    for rule, n in cleaning["dropped_by_rule"].items():
        print(f"  dropped {n:4d}  {rule}")

    study = {"dataset": str(args.src), "cleaning": cleaning,
             "targets": {key: train_target(df, key, args.permutations) for key in TARGETS}}
    (models_dir / "ev_charging_patterns_study.json").write_text(json.dumps(study, indent=2), encoding="utf-8")

    # Energy for a requested SOC window has no real-data model (no public dataset records SOC),
    # so the service uses physics; this card records why.
    energy = {**study["targets"]["energy"], "dataset": "ev_charging_patterns.csv (study only)"}
    energy["limitations"] = [
        "Energy uses the physics estimator: capacity × SOC window × estimated SOH ÷ charging efficiency.",
        "No public session dataset records SOC, so no real-data model can learn energy for a SOC window.",
    ] + energy["limitations"]
    (models_dir / "energy_model_metadata.json").write_text(json.dumps(energy, indent=2), encoding="utf-8")
    print(f"\nStudy written to {models_dir / 'ev_charging_patterns_study.json'}")


if __name__ == "__main__":
    main()
