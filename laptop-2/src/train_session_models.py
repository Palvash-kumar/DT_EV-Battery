#!/usr/bin/env python3
"""
train_session_models.py — Models trained on real charging sessions.

  duration  charging time (h) from energy, the car's power limit and start time
            (Palo Alto; ACN-Data used as an external test from other sites)
  cost      fee paid (USD) from energy, charging time and idle time (Palo Alto 2017-2020)
  idle      hours a car stays plugged in after charging ends (Palo Alto)

Every model is compared against simple baselines on the same rows. Splits are
95/5 by driver, so test drivers are never seen in training, and the model is
chosen by 5-fold grouped CV on the 95 %.

Usage:
    cd laptop-2
    python src/prepare_sessions.py
    python src/train_session_models.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import GroupKFold, GroupShuffleSplit, cross_val_predict
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "ml_service"))
from model_wrappers import RatioToReference, TariffPlusResidual  # noqa: E402
DATA = ROOT / "data" / "charging_sessions" / "processed" / "sessions.parquet"
MODELS = ROOT / "models"
SEED = 42
TARIFF_USD_PER_KWH = 0.23  # Palo Alto's published energy rate since 2017

TASKS = {
    "duration": {
        "target": "charge_h", "units": "hours",
        "numeric": ["energy_kwh", "vehicle_power_kw", "ideal_h", "hour", "weekday", "month"],
        "categorical": ["port_type"],
    },
    "cost": {
        "target": "fee_usd", "units": "USD",
        "numeric": ["energy_kwh", "charge_h", "idle_h", "hour", "weekday"],
        "categorical": ["port_type"],
    },
    "idle": {
        "target": "idle_h", "units": "hours",
        "numeric": ["energy_kwh", "charge_h", "hour", "weekday"],
        "categorical": ["port_type"],
    },
}


def candidates(key: str) -> dict:
    task = TASKS[key]
    prep = lambda: ColumnTransformer([  # noqa: E731
        ("num", StandardScaler(), task["numeric"]),
        ("cat", OneHotEncoder(handle_unknown="ignore"), task["categorical"]),
    ])
    hgb = lambda loss: HistGradientBoostingRegressor(  # noqa: E731
        loss=loss, max_iter=400, learning_rate=0.05, max_leaf_nodes=63, min_samples_leaf=50,
        l2_regularization=1.0, random_state=SEED)
    models = {
        "MeanBaseline": Pipeline([("prep", prep()), ("model", DummyRegressor())]),
        "Ridge": Pipeline([("prep", prep()), ("model", Ridge(alpha=1.0))]),
        "HistGradientBoosting": Pipeline([("prep", prep()), ("model", hgb("squared_error"))]),
        "HistGradientBoosting-MAE": Pipeline([("prep", prep()), ("model", hgb("absolute_error"))]),
    }
    if key == "duration":
        models["HistGradientBoosting-MAE-ratio"] = RatioToReference(
            Pipeline([("prep", prep()), ("model", hgb("absolute_error"))]), reference="ideal_h")
    if key == "cost":
        models["HistGradientBoosting-MAE-tariff"] = TariffPlusResidual(
            Pipeline([("prep", prep()), ("model", hgb("absolute_error"))]), energy="energy_kwh")
    return models


def scores(y, p) -> dict:
    return {"mae": round(float(mean_absolute_error(y, p)), 4),
            "rmse": round(float(np.sqrt(mean_squared_error(y, p))), 4),
            "r2": round(float(r2_score(y, p)), 4)}


def formula_baseline(key: str, X: pd.DataFrame) -> pd.Series | None:
    if key == "duration":
        return X["energy_kwh"] / X["vehicle_power_kw"]  # ideal: full power the whole time
    if key == "cost":
        return X["energy_kwh"] * TARIFF_USD_PER_KWH     # energy tariff only, no idle fees
    return None


def rows_for(key: str, df: pd.DataFrame) -> pd.DataFrame:
    if key == "duration":
        return df[(df["dataset"] == "palo_alto") & df["vehicle_power_kw"].notna()]
    if key == "cost":
        return df[(df["dataset"] == "palo_alto") & df["fee_usd"].notna()]
    return df[df["dataset"] == "palo_alto"]


def train_task(key: str, df: pd.DataFrame) -> dict:
    task = TASKS[key]
    data = rows_for(key, df).dropna(subset=task["numeric"] + task["categorical"] + [task["target"]])
    data = data[data["user_key"].notna()].reset_index(drop=True)
    X, y, groups = data[task["numeric"] + task["categorical"]], data[task["target"]], data["user_key"]

    tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.05, random_state=SEED).split(X, y, groups))
    Xtr, ytr, gtr, Xte, yte = X.iloc[tr], y.iloc[tr], groups.iloc[tr], X.iloc[te], y.iloc[te]
    print(f"\n=== {key}: {task['target']}  train {len(tr)} rows / {gtr.nunique()} drivers, "
          f"test {len(te)} rows / {groups.iloc[te].nunique()} unseen drivers ===")

    results = {}
    cv = GroupKFold(n_splits=5)
    for name, pipe in candidates(key).items():
        cv_pred = cross_val_predict(pipe, Xtr, ytr, groups=gtr, cv=cv, n_jobs=-1)
        pipe.fit(Xtr, ytr)
        c, t = scores(ytr, cv_pred), scores(yte, pipe.predict(Xte))
        results[name] = {"cv_mae": c["mae"], "cv_r2": c["r2"], "test_mae": t["mae"],
                         "test_rmse": t["rmse"], "test_r2": t["r2"]}
        print(f"  {name:22s} CV MAE={c['mae']:.3f}  R²={c['r2']:.3f} | test MAE={t['mae']:.3f}  R²={t['r2']:.3f}")
    base = formula_baseline(key, Xte)
    if base is not None:
        t = scores(yte, base)
        results["FormulaBaseline"] = {"test_mae": t["mae"], "test_rmse": t["rmse"], "test_r2": t["r2"]}
        print(f"  {'FormulaBaseline':22s} (no training)            | test MAE={t['mae']:.3f}  R²={t['r2']:.3f}")

    trained = [n for n in results if n not in ("MeanBaseline", "FormulaBaseline")]
    best = min(trained, key=lambda n: results[n]["cv_mae"])
    model = candidates(key)[best].fit(X, y)
    joblib.dump(model, MODELS / f"session_{key}.joblib")

    meta = {
        "task": f"session_{key}",
        "target": task["target"],
        "target_units": task["units"],
        "features_numeric": task["numeric"],
        "features_categorical": task["categorical"],
        "selected_model": best,
        "all_results": results,
        "train_rows": int(len(tr)),
        "test_rows": int(len(te)),
        "split": "95/5 by driver (test drivers unseen); model chosen by 5-fold grouped CV on the 95 %",
        "dataset": "City of Palo Alto EV charging sessions 2011-2020",
        "training_date": datetime.now(timezone.utc).isoformat(),
    }

    if key == "duration":
        acn = df[df["dataset"].str.startswith("acn") & df["vehicle_power_kw"].notna()]
        if len(acn):
            ext = scores(acn[task["target"]], model.predict(acn[task["numeric"] + task["categorical"]]))
            ext_base = scores(acn[task["target"]], formula_baseline(key, acn))
            meta["external_test_acn"] = {"rows": int(len(acn)), "model": ext, "formula_baseline": ext_base}
            print(f"  External test on ACN-Data ({len(acn)} sessions, other sites): model MAE={ext['mae']:.3f} "
                  f"R²={ext['r2']:.3f} vs formula MAE={ext_base['mae']:.3f} R²={ext_base['r2']:.3f}")
    return meta


def main():
    df = pd.read_parquet(DATA)
    # Physics-informed feature: time at the car's full power; the model learns the real-world correction
    df["ideal_h"] = df["energy_kwh"] / df["vehicle_power_kw"]
    limitations = {
        "duration": [
            "Learned from Level 1/2 public chargers (2011-2020 fleet); DC fast charging uses the physics estimator.",
            "vehicle_power_kw is the car's charging limit; in the data it is estimated from each driver's other sessions.",
        ],
        "cost": [
            "Learned from Palo Alto's real fees: $0.23/kWh plus fees for long plug-in times. Other sites price differently.",
            "DC fast charging is not in the data; its cost uses a typical DC price per kWh.",
        ],
        "idle": ["Driver behaviour differs between sites; this reflects Palo Alto public chargers."],
    }
    for key in TASKS:
        meta = train_task(key, df)
        meta["limitations"] = limitations[key]
        name = {"duration": "duration_model_metadata.json", "cost": "cost_model_metadata.json",
                "idle": "idle_model_metadata.json"}[key]
        (MODELS / name).write_text(json.dumps(meta, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
