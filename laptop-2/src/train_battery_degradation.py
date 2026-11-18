#!/usr/bin/env python3
"""
train_battery_degradation.py — Cycle life, RUL and early life prediction (ISU-ILCC).

  life   cycles (EFC) until capacity falls to 80 %, from charge C-rate, discharge
         C-rate and depth of discharge. Used for the per-session wear factor.
  rul    remaining EFC to 80 % from the current state (EFC so far, retention)
         and the usage conditions.
  early  life predicted from the change in the discharge voltage curve over
         the first capacity checks (as in Severson et al. 2019), plus conditions.

All splits are by test condition (group): the 4 cells of a condition are
either all in train or all in test, so scores measure unseen conditions.
95/5 split by group, model chosen by 10-fold grouped CV on the 95 %.

Usage:
    cd laptop-2
    python src/prepare_isu.py
    python src/train_battery_degradation.py
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.base import clone
from sklearn.dummy import DummyRegressor
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import RBF, ConstantKernel, WhiteKernel
from sklearn.linear_model import Ridge
from sklearn.metrics import mean_absolute_error, mean_absolute_percentage_error, r2_score
from sklearn.model_selection import GroupKFold, GroupShuffleSplit, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import PolynomialFeatures, StandardScaler

ROOT = Path(__file__).resolve().parent.parent
PROC = ROOT / "data" / "battery_aging" / "processed"
QDIR = ROOT / "data" / "battery_aging" / "raw" / "isu_ilcc" / "Q_interpolated"
MODELS = ROOT / "models"
SEED = 42
CONDITION_FEATURES = ["charge_c", "discharge_c", "dod_pct"]
EARLY_EFC = 25.0  # capacity check used for early prediction: first one after >= 25 EFC

DATASET = "ISU-ILCC Battery Aging Dataset (NMC/graphite 502030 pouch, 250 mAh, 30 °C), CC BY 4.0"
LIMITATIONS = [
    "Lab cells cycled at 30 °C with constant currents; EV packs see variable temperature, rest and calendar aging.",
    "Charge rates 0.5-3C and depth of discharge 4-98 % were tested; inputs outside that range are clamped.",
    "EFC = cumulative discharged Ah / rated capacity. End of life = 80 % of the first measured capacity.",
]


def candidates(n_features: int) -> dict:
    kernel = ConstantKernel(1.0) * RBF(length_scale=[1.0] * n_features, length_scale_bounds=(0.05, 50)) + WhiteKernel(0.1)
    return {
        "MeanBaseline": DummyRegressor(),
        "Ridge-poly2": make_pipeline(StandardScaler(), PolynomialFeatures(2), Ridge(alpha=1.0)),
        "GaussianProcess": make_pipeline(StandardScaler(), GaussianProcessRegressor(
            kernel=kernel, normalize_y=True, n_restarts_optimizer=3, random_state=SEED)),
        "RandomForest": RandomForestRegressor(n_estimators=500, min_samples_leaf=3, random_state=SEED, n_jobs=-1),
        "HistGradientBoosting": HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, max_depth=3,
                                                              min_samples_leaf=8, random_state=SEED),
    }


def score(y, p) -> dict:
    return {"mae": round(float(mean_absolute_error(y, p)), 2),
            "mape_pct": round(float(100 * mean_absolute_percentage_error(y, p)), 2),
            "r2": round(float(r2_score(y, p)), 4)}


def fit_task(name: str, X: pd.DataFrame, y: pd.Series, groups: pd.Series, log_target: bool,
             models: dict | None = None, select_by: str = "cv_mae") -> tuple[dict, str, object]:
    """Grouped 95/5 split + grouped CV. Targets are modelled in log space when log_target."""
    models = models or candidates(X.shape[1])
    f = np.log if log_target else (lambda v: v)
    inv = np.exp if log_target else (lambda v: v)
    tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.05, random_state=SEED).split(X, y, groups))
    test_groups = sorted(groups.iloc[te].unique().tolist())
    print(f"\n=== {name}: {len(tr)} train rows / {groups.iloc[tr].nunique()} conditions, "
          f"{len(te)} test rows / unseen conditions {test_groups} ===")
    cv = GroupKFold(n_splits=10)
    results = {}
    for mname, model in models.items():
        p_cv = inv(cross_val_predict(model, X.iloc[tr], f(y.iloc[tr]), groups=groups.iloc[tr], cv=cv, n_jobs=-1))
        model.fit(X.iloc[tr], f(y.iloc[tr]))
        c, t = score(y.iloc[tr], p_cv), score(y.iloc[te], inv(model.predict(X.iloc[te])))
        results[mname] = {"cv_mae": c["mae"], "cv_mape_pct": c["mape_pct"], "cv_r2": c["r2"],
                          "test_mae": t["mae"], "test_mape_pct": t["mape_pct"], "test_r2": t["r2"]}
        print(f"  {mname:22s} CV MAE={c['mae']:8.1f}  MAPE={c['mape_pct']:5.1f}%  R²={c['r2']:.3f} | "
              f"test MAE={t['mae']:8.1f}  R²={t['r2']:.3f}")
    best = min((n for n in results if n != "MeanBaseline"), key=lambda n: results[n][select_by])
    final = clone(models[best]).fit(X, f(y))
    return {"all_results": results, "selected_model": best, "test_groups": test_groups,
            "train_rows": int(len(tr)), "test_rows": int(len(te)), "selected_by": select_by}, best, final


def early_features(rpt: pd.DataFrame) -> pd.DataFrame:
    """Severson-style features from ΔQ(V) = Q_early(V) - Q_first(V) on the C/5 discharge curve."""
    files = {p.stem: p for p in sorted(QDIR.rglob("*.csv"))}
    rows = []
    for cell, g in rpt.groupby("cell"):
        early = g[g["efc"] >= EARLY_EFC]
        if cell not in files or early.empty:
            continue
        q = pd.read_csv(files[cell], header=None).to_numpy()
        k = int(early["rpt"].iloc[0])
        if k >= q.shape[1] or np.isnan(q[:, k]).all():
            continue
        dq = q[:, k] - q[:, 0]
        rows.append({"cell": cell, "log_var_dq": np.log10(np.var(dq) + 1e-12),
                     "log_abs_min_dq": np.log10(abs(dq.min()) + 1e-12), "mean_dq": dq.mean(),
                     "early_retention_pct": float(early["retention_pct"].iloc[0]),
                     "early_efc": float(early["efc"].iloc[0])})
    return pd.DataFrame(rows)


def main():
    rpt = pd.read_parquet(PROC / "isu_rpt.parquet")
    life = pd.read_parquet(PROC / "isu_life.parquet").dropna(subset=["life_efc"])

    # 1. Cycle life from usage conditions
    # Selected by relative error: the wear factor is a ratio of two predicted lives
    meta_life, best, model = fit_task("life (EFC to 80 %)", life[CONDITION_FEATURES], life["life_efc"],
                                      life["group"], log_target=True, select_by="cv_mape_pct")
    joblib.dump(model, MODELS / "battery_life.joblib")

    # 2. RUL from current state + conditions (rows still above end of life)
    r = rpt.merge(life[["cell", "life_efc"]], on="cell")
    r = r[r["retention_pct"] > 80].assign(rul_efc=lambda d: d["life_efc"] - d["efc"])
    r = r[r["rul_efc"] > 0].reset_index(drop=True)
    rul_features = CONDITION_FEATURES + ["efc", "retention_pct"]
    rul_models = {k: v for k, v in candidates(len(rul_features)).items() if k != "GaussianProcess"}  # too many rows for exact GP
    meta_rul, best_rul, rul_model = fit_task("RUL (remaining EFC)", r[rul_features], r["rul_efc"], r["group"],
                                             log_target=False, models=rul_models)
    joblib.dump(rul_model, MODELS / "battery_rul.joblib")

    # 3. Early life prediction: conditions only vs conditions + early voltage-curve change
    ef = early_features(rpt).merge(life, on="cell")
    ef = ef[ef["life_efc"] > ef["early_efc"]].reset_index(drop=True)
    early_cols = CONDITION_FEATURES + ["log_var_dq", "log_abs_min_dq", "mean_dq", "early_retention_pct"]
    meta_cond_only, _, _ = fit_task("early: conditions only (same cells)", ef[CONDITION_FEATURES], ef["life_efc"],
                                    ef["group"], log_target=True)
    meta_early, _, _ = fit_task(f"early: conditions + ΔQ(V) after {EARLY_EFC:g} EFC", ef[early_cols],
                                ef["life_efc"], ef["group"], log_target=True)

    now = datetime.now(timezone.utc).isoformat()
    common = {"dataset": DATASET, "split": "95/5 by test condition; model chosen by 10-fold grouped CV on the 95 %",
              "training_date": now, "limitations": LIMITATIONS}
    (MODELS / "battery_life_model_metadata.json").write_text(json.dumps({
        "task": "battery_cycle_life", "target": "life_efc", "target_units": "EFC to 80 % capacity",
        "features": CONDITION_FEATURES, **meta_life, **common,
        "life_efc_range": [round(float(life["life_efc"].min()), 1), round(float(life["life_efc"].max()), 1)],
        "early_prediction": {"early_capacity_check_efc": EARLY_EFC, "features": early_cols,
                             "conditions_only": meta_cond_only, "conditions_plus_early_curve": meta_early},
    }, indent=2), encoding="utf-8")
    rul_test = meta_rul["all_results"][best_rul]
    (MODELS / "rul_model_metadata.json").write_text(json.dumps({
        "task": "battery_rul", "target": "rul_efc", "target_units": "EFC to 80 % capacity",
        "features": rul_features, **meta_rul, **common,
        "test_batteries": [f"condition group {g}" for g in meta_rul["test_groups"]],
        "summary": f"{best_rul}: MAE {rul_test['test_mae']} EFC on unseen test conditions",
    }, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
