#!/usr/bin/env python3
"""
train_battery_soh.py — Estimate battery SOH from the charging curve (NASA PCoE).

The features are what a charger sees during a CC-CV charge, so a station can
estimate health while a car charges. Every split is by battery: rows from one
cell never appear in both train and test.

  * 95/5 split by battery (one held-out battery), model chosen by
    leave-one-battery-out CV on the 95 %
  * leave-one-battery-out over all batteries for the per-battery error table

Usage:
    cd laptop-2
    python src/prepare_nasa.py
    python src/train_battery_soh.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesRegressor, HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GroupShuffleSplit, LeaveOneGroupOut, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "battery_aging" / "processed" / "nasa_cycles.parquet"
MODELS = ROOT / "models"
SEED = 42

# 24 °C and 43 °C constant-protocol groups. Batteries 38-56 (4 °C and mixed
# loads) are excluded: NASA's README reports unexplained low-capacity runs there.
SOH_BATTERIES = ["B0005", "B0006", "B0007", "B0018", "B0025", "B0026", "B0027", "B0028",
                 "B0029", "B0030", "B0031", "B0032", "B0033", "B0034", "B0036"]
FEATURES = ["q_window_ah", "t_window_s", "cv_time_s", "charge_end_temp_c",
            "ambient_temp_c", "discharge_current_a"]
TARGET = "soh_pct"


def candidates():
    return {
        "Ridge": make_pipeline(StandardScaler(), Ridge(alpha=1.0)),
        "RandomForest": RandomForestRegressor(n_estimators=400, min_samples_leaf=3, random_state=SEED, n_jobs=-1),
        "ExtraTrees": ExtraTreesRegressor(n_estimators=400, min_samples_leaf=3, random_state=SEED, n_jobs=-1),
        "HistGradientBoosting": HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, max_depth=4,
                                                              min_samples_leaf=20, random_state=SEED),
    }


def scores(y, p) -> dict:
    return {"mae": round(float(mean_absolute_error(y, p)), 3),
            "rmse": round(float(np.sqrt(mean_squared_error(y, p))), 3),
            "r2": round(float(r2_score(y, p)), 4)}


def main():
    df = pd.read_parquet(DATA)
    df = df[df["battery_id"].isin(SOH_BATTERIES)].dropna(subset=FEATURES + [TARGET]).reset_index(drop=True)
    X, y, groups = df[FEATURES], df[TARGET], df["battery_id"]

    train_idx, test_idx = next(GroupShuffleSplit(n_splits=1, test_size=0.05, random_state=SEED).split(X, y, groups))
    Xtr, ytr, gtr = X.iloc[train_idx], y.iloc[train_idx], groups.iloc[train_idx]
    test_batteries = sorted(groups.iloc[test_idx].unique())
    print(f"SOH: {len(df)} cycles from {groups.nunique()} batteries; held-out test battery: {test_batteries}")

    logo = LeaveOneGroupOut()
    results = {}
    for name, model in candidates().items():
        cv_pred = cross_val_predict(model, Xtr, ytr, groups=gtr, cv=logo, n_jobs=-1)
        model.fit(Xtr, ytr)
        test = scores(y.iloc[test_idx], model.predict(X.iloc[test_idx]))
        cv = scores(ytr, cv_pred)
        results[name] = {"cv_mae": cv["mae"], "cv_rmse": cv["rmse"], "cv_r2": cv["r2"],
                         "test_mae": test["mae"], "test_rmse": test["rmse"], "test_r2": test["r2"]}
        print(f"  {name:22s} LOBO-CV MAE={cv['mae']:.2f} %  R²={cv['r2']:.3f}  | held-out battery MAE={test['mae']:.2f} %")

    best = min(results, key=lambda n: results[n]["cv_mae"])
    all_pred = cross_val_predict(candidates()[best], X, y, groups=groups, cv=logo, n_jobs=-1)
    per_battery = {
        b: {"cycles": int((groups == b).sum()), **scores(y[groups == b], all_pred[groups == b])}
        for b in sorted(groups.unique())
    }
    overall = scores(y, all_pred)
    print(f"Selected {best}. Leave-one-battery-out on all {groups.nunique()} batteries: "
          f"MAE={overall['mae']:.2f} %  R²={overall['r2']:.3f}")

    final = candidates()[best].fit(X, y)
    joblib.dump(final, MODELS / "soh.joblib")
    np.savez(MODELS / "soh_residuals.npz", y_true=y.to_numpy(), y_pred=all_pred,
             battery_id=groups.to_numpy(), cycle=df["cycle"].to_numpy())

    meta = {
        "task": "battery_soh_from_charge_curve",
        "target": "soh_pct",
        "target_units": "% of rated capacity (2.0 Ah)",
        "features": FEATURES,
        "selected_model": best,
        "all_results": results,
        "leave_one_battery_out": overall,
        "per_battery_errors": per_battery,
        "test_batteries": test_batteries,
        "train_rows": int(len(train_idx)),
        "test_rows": int(len(test_idx)),
        "split": "95/5 by battery (1 held-out battery); model chosen by leave-one-battery-out CV",
        "dataset": "NASA PCoE Battery Data Set (Saha & Goebel 2007), LiCoO2 18650, 2.0 Ah",
        "batteries_used": SOH_BATTERIES,
        "batteries_excluded": "B0038-B0056 (4 °C / mixed-load groups with NASA-reported capacity anomalies)",
        "training_date": datetime.now(timezone.utc).isoformat(),
        "limitations": [
            "Lab LiCoO2 18650 cells charged with one fixed CC-CV protocol (1.5 A to 4.2 V); EV packs use other chemistries.",
            "Features come from the 3.9-4.2 V part of a full CC-CV charge; a short top-up charge gives no estimate.",
            "Capacity labels depend on the discharge current used in the test, so it is a model input.",
        ],
    }
    (MODELS / "soh_model_metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(json.dumps(per_battery, indent=1)[:2000])


if __name__ == "__main__":
    main()
