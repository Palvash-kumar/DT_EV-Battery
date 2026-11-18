#!/usr/bin/env python3
"""Generate every figure used in report.tex from the project's own data and trained models.

Run from the repository root:   python report/make_figures.py
Writes the figures to report/figures/.

Honesty rules followed here:
  * Result plots re-create the exact grouped 95/5 split (seed 42) of the training scripts and fit the
    selected model on the 95 % only, so test points are never seen in training. The script checks that
    the reproduced test score equals the score stored in laptop-2/models/*_metadata.json.
  * The wear-factor and temperature-response curves call the deployed inference code (laptop-2/ml_service).
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
ML = ROOT / "laptop-2"
OUT = ROOT / "report" / "figures"
OUT.mkdir(parents=True, exist_ok=True)
SEED = 42

# The inference worker's config requires MQTT settings at import time; plotting never connects.
for k, v in {"MQTT_HOST": "127.0.0.1", "MQTT_USERNAME": "unused", "MQTT_PASSWORD": "unused"}.items():
    os.environ.setdefault(k, v)
sys.path.insert(0, str(ML / "ml_service"))
try:  # config.py reads an optional .env file; a no-op stand-in is enough for plotting
    import dotenv  # noqa: F401
except ImportError:
    import types
    sys.modules["dotenv"] = types.SimpleNamespace(load_dotenv=lambda *a, **k: False)

plt.rcParams.update({
    "font.family": "DejaVu Sans", "font.size": 8, "axes.titlesize": 8.5, "axes.labelsize": 8,
    "xtick.labelsize": 7, "ytick.labelsize": 7, "legend.fontsize": 7, "axes.spines.top": False,
    "axes.spines.right": False, "axes.grid": True, "grid.color": "#e3e3e3", "grid.linewidth": 0.6,
    "savefig.bbox": "tight", "savefig.pad_inches": 0.03, "pdf.fonttype": 42,
})
BLUE, LBLUE, ORANGE, GREEN, LGREEN = "#2a6fbb", "#9ec2ea", "#e07b29", "#2e9d4f", "#9fd6af"
GREY, LGREY, RED, PURPLE = "#7d7d79", "#c9c9c6", "#c8423a", "#7a4fb0"


def meta(name: str) -> dict:
    return json.loads((ML / "models" / name).read_text(encoding="utf-8"))


# ─────────────────────────────────────────────────────────────────────────────
# Figure 1 — block diagram
# ─────────────────────────────────────────────────────────────────────────────
def block_diagram():
    fig, ax = plt.subplots(figsize=(7.2, 4.5))
    ax.set_xlim(0, 100)
    ax.set_ylim(0, 63)
    ax.axis("off")

    def tier(x, y, w, h, title, color):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.2,rounding_size=1.2",
                                    fc=color, ec="#a0a0a0", lw=0.8, alpha=0.25, zorder=0))
        if title:
            ax.text(x + w / 2, y + h - 1.4, title, ha="center", va="top", fontsize=7, weight="bold", color="#222")

    def box(x, y, w, h, title, sub="", color="#ffffff"):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.15,rounding_size=0.8",
                                    fc=color, ec="#444", lw=0.9, zorder=2))
        nsub = sub.count("\n") + 1 if sub else 0
        ty = y + h - 2.3 if nsub else y + h / 2
        ax.text(x + w / 2, ty, title, ha="center", va="center", fontsize=6.6, weight="bold", zorder=3)
        if sub:
            ax.text(x + w / 2, (y + ty - 1.4) / 2 + 0.2, sub, ha="center", va="center", fontsize=5.6,
                    color="#333", zorder=3, linespacing=1.2)
        return {"l": (x, y + h / 2), "r": (x + w, y + h / 2), "t": (x + w / 2, y + h), "b": (x + w / 2, y),
                "x": x, "y": y, "w": w, "h": h}

    def arrow(p, q, color="#333", both=False, rad=0.0):
        ax.add_patch(FancyArrowPatch(p, q, arrowstyle=("<|-|>" if both else "-|>"), mutation_scale=8,
                                     lw=1.0, color=color, connectionstyle=f"arc3,rad={rad}", zorder=4,
                                     shrinkA=1.0, shrinkB=1.0))

    def label(x, y, text, color="#333", ha="center"):
        ax.text(x, y, text, ha=ha, va="center", fontsize=5.6, color=color, zorder=5, style="italic",
                linespacing=1.1, bbox=dict(boxstyle="round,pad=0.12", fc="white", ec="none", alpha=0.92))

    # Tiers: one per machine + the offline training band
    tier(0.5, 12.5, 31, 50, "Sensor laptop (Windows) + sensor", "#f2b27a")
    tier(34.5, 12.5, 31, 50, "ML laptop (macOS)", "#b9a3e0")
    tier(68.5, 12.5, 31, 50, "Web laptop (Windows)", "#8fc9b0")
    tier(0.5, 0.3, 99, 10.6, "", "#d0d0d0")
    ax.text(2.0, 9.4, "Offline training (ML laptop, run once)", fontsize=6.6, weight="bold", color="#222", va="center")

    # Sensor laptop column (data flows upward to the OPC UA server)
    opc = box(3, 47, 26, 9, "OPC UA server :4840", "node TemperatureC\nvalue + status + timestamp")
    rdr = box(3, 34.5, 26, 8, "Serial reader + 5 s sampler", "range check, calibration offset")
    ard = box(3, 23, 26, 7.5, "Arduino UNO R4 WiFi", "A0, 12-bit ADC, 20-sample mean", "#fff4e8")
    lm = box(3, 14, 26, 5.5, "LM35 temperature sensor", "", "#fff4e8")
    arrow(lm["t"], ard["b"])
    label(16, 21.3, "analog voltage")
    arrow(ard["t"], rdr["b"])
    label(16, 32.5, "USB serial, 9600 baud")
    arrow(rdr["t"], opc["b"])

    # ML laptop column
    brg = box(37, 47, 26, 9, "OPC UA → MQTT bridge", "subscribes to TemperatureC,\nchecks schema, publishes QoS 1",
              "#f6f1ff")
    brk = box(37, 31.5, 26, 9.5, "Mosquitto MQTT broker", ":1883, password + ACL\ntopics evdt/v1/…", "#f6f1ff")
    wrk = box(37, 14, 26, 12, "ML inference worker", "schema check + de-duplication\nphysics model + scikit-learn\n"
              "time, energy, cost, wear, SOH, RUL", "#ece2ff")
    arrow(brg["b"], brk["t"], PURPLE)
    label(50, 44, "telemetry", PURPLE)
    arrow((43, brk["y"]), (43, wrk["y"] + wrk["h"]), PURPLE)
    label(43, 28.75, "request", PURPLE)
    arrow((57, wrk["y"] + wrk["h"]), (57, brk["y"]), PURPLE)
    label(57, 28.75, "results", PURPLE)

    # Web laptop column
    ui = box(71, 47, 26, 9, "React dashboard (browser)", "request form, history, alerts,\nThree.js 3D station twin",
             "#eaf6f0")
    be = box(71, 31.5, 26, 9.5, "Express backend :3000", "validation, request lifecycle,\nsensor monitor, alerts",
             "#eaf6f0")
    db = box(71, 14, 26, 9, "MongoDB", "requests, results, telemetry,\nalerts, provenance", "#eaf6f0")
    arrow(be["t"], ui["b"], GREEN, both=True)
    label(84, 44, "REST + Socket.IO", GREEN)
    arrow(be["b"], db["t"], GREEN, both=True)
    label(84, 27.25, "store / query", GREEN)

    # Cross-machine links (horizontal)
    arrow(opc["r"], brg["l"], ORANGE)
    label(33, 54.0, "OPC UA", ORANGE)
    label(33, 49.0, "subscribe", ORANGE)
    arrow(brk["r"], be["l"], BLUE, both=True)
    label(67, 39.0, "MQTT", BLUE)
    label(67, 33.6, "QoS 1", BLUE)

    # Offline pipeline, ending under the worker
    ds = box(2, 1.5, 21, 6, "Public datasets", "Palo Alto, ACN, ISU, NASA")
    prep = box(26.5, 1.5, 17, 6, "Clean + features", "prepare_*.py")
    trn = box(47, 1.5, 19, 6, "Train + grouped CV", "95/5 by driver / cell")
    jl = box(69.5, 1.5, 19, 6, "Model files", ".joblib + metadata")
    arrow(ds["r"], prep["l"])
    arrow(prep["r"], trn["l"])
    arrow(trn["r"], jl["l"])
    arrow((72.5, 7.6), (61.5, 14.0), "#444", rad=0.2)
    label(72.5, 11.2, "loaded at start-up", "#444", ha="left")

    fig.savefig(OUT / "block_diagram.pdf")
    plt.close(fig)


# ─────────────────────────────────────────────────────────────────────────────
# Figure 2 — charging-session models (Palo Alto)
# ─────────────────────────────────────────────────────────────────────────────
def session_results():
    from sklearn.compose import ColumnTransformer
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.metrics import mean_absolute_error, r2_score
    from sklearn.model_selection import GroupShuffleSplit
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import OneHotEncoder, StandardScaler
    from model_wrappers import RatioToReference

    m = meta("duration_model_metadata.json")
    num, cat, target = m["features_numeric"], m["features_categorical"], m["target"]
    df = pd.read_parquet(ML / "data" / "charging_sessions" / "processed" / "sessions.parquet")
    df["ideal_h"] = df["energy_kwh"] / df["vehicle_power_kw"]
    d = df[(df["dataset"] == "palo_alto") & df["vehicle_power_kw"].notna()]
    d = d.dropna(subset=num + cat + [target])
    d = d[d["user_key"].notna()].reset_index(drop=True)
    X, y, g = d[num + cat], d[target], d["user_key"]
    tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.05, random_state=SEED).split(X, y, g))
    prep = ColumnTransformer([("num", StandardScaler(), num), ("cat", OneHotEncoder(handle_unknown="ignore"), cat)])
    hgb = HistGradientBoostingRegressor(loss="absolute_error", max_iter=400, learning_rate=0.05, max_leaf_nodes=63,
                                        min_samples_leaf=50, l2_regularization=1.0, random_state=SEED)
    model = RatioToReference(Pipeline([("prep", prep), ("model", hgb)]), reference="ideal_h").fit(X.iloc[tr], y.iloc[tr])
    p = model.predict(X.iloc[te])
    yt = y.iloc[te].to_numpy()
    mae, r2 = mean_absolute_error(yt, p), r2_score(yt, p)
    stored = m["all_results"][m["selected_model"]]
    print(f"duration: reproduced test MAE={mae:.4f} R2={r2:.4f}  stored MAE={stored['test_mae']} R2={stored['test_r2']}"
          f"  n_test={len(te)} drivers={g.iloc[te].nunique()}")
    assert abs(mae - stored["test_mae"]) < 2e-3, "reproduced test score differs from the stored metadata"

    fig, (a, b, c) = plt.subplots(1, 3, figsize=(7.2, 2.25), gridspec_kw={"width_ratios": [1.1, 1, 1]})
    lim = 10
    hb = a.hexbin(yt, p, gridsize=40, extent=(0, lim, 0, lim), bins="log", cmap="Blues", mincnt=1, lw=0)
    a.plot([0, lim], [0, lim], color=RED, lw=0.9, ls="--", label="ideal (y = x)")
    a.set(xlim=(0, lim), ylim=(0, lim), xlabel="actual time (h)", ylabel="predicted time (h)")
    a.set_aspect("equal")
    a.set_title(f"(a) Charging time: {len(te):,}\nsessions, {g.iloc[te].nunique()} unseen drivers")
    a.text(0.4, 9.5, f"MAE {mae:.3f} h\n(≈{mae*60:.0f} min)\nR² = {r2:.3f}", fontsize=6.5, va="top",
           bbox=dict(fc="white", ec="#ccc", boxstyle="round,pad=0.25"))
    a.legend(loc="lower right", frameon=False, fontsize=6.5)
    a.grid(False)
    cb = fig.colorbar(hb, ax=a, pad=0.03, fraction=0.046)
    cb.ax.tick_params(labelsize=6)
    cb.set_label("sessions per cell", fontsize=6.3)

    def bars(axis, res, order, names, scale, unit, title, sel):
        ypos = np.arange(len(order))[::-1].astype(float)
        h = 0.36
        cvv = [res[k].get("cv_mae") for k in order]
        tev = [res[k]["test_mae"] for k in order]
        mx = max(v for v in cvv + tev if v is not None) * scale
        for i, k in enumerate(order):
            base = k in ("MeanBaseline", "FormulaBaseline")
            dark = GREEN if k == sel else (GREY if base else BLUE)
            light = LGREEN if k == sel else (LGREY if base else LBLUE)
            if cvv[i] is not None:
                axis.barh(ypos[i] + h / 2, cvv[i] * scale, height=h, color=light)
            axis.barh(ypos[i] - h / 2, tev[i] * scale, height=h, color=dark)
            fmt = "{:.2f}" if unit == "USD" else "{:.1f}"
            axis.text(tev[i] * scale + mx * 0.02, ypos[i] - h / 2, fmt.format(tev[i] * scale), va="center",
                      fontsize=5.8)
        axis.set_yticks(ypos, names)
        axis.set_xlim(0, mx * 1.2)
        axis.set_xlabel(f"mean absolute error ({unit})")
        axis.set_title(title)
        axis.grid(axis="y", visible=False)
        from matplotlib.patches import Patch
        axis.legend(handles=[Patch(color=LBLUE, label="grouped CV (95 %)"), Patch(color=BLUE, label="test (5 %)")],
                    loc="center left", bbox_to_anchor=(0.42, 0.5), frameon=False, fontsize=6, handlelength=1.0)

    order = ["MeanBaseline", "FormulaBaseline", "Ridge", "HistGradientBoosting", "HistGradientBoosting-MAE",
             "HistGradientBoosting-MAE-ratio"]
    names = ["predict mean", "physics formula", "Ridge", "HGB (squared)", "HGB (abs. error)",
             "physics × HGB\n(selected)"]
    bars(b, m["all_results"], order, names, 60, "minutes", "(b) Charging-time candidates",
         "HistGradientBoosting-MAE-ratio")

    mc = meta("cost_model_metadata.json")
    order_c = ["MeanBaseline", "FormulaBaseline", "Ridge", "HistGradientBoosting", "HistGradientBoosting-MAE",
               "HistGradientBoosting-MAE-tariff"]
    names_c = ["predict mean", "flat $0.23/kWh", "Ridge", "HGB (squared)", "HGB (abs. error)",
               "tariff + HGB\n(selected)"]
    bars(c, mc["all_results"], order_c, names_c, 1, "USD", "(c) Session-cost candidates",
         "HistGradientBoosting-MAE-tariff")
    fig.tight_layout(w_pad=0.6)
    fig.savefig(OUT / "session_results.pdf")
    plt.close(fig)


# ─────────────────────────────────────────────────────────────────────────────
# Figure 3 — battery model + how the live temperature changes the twin's prediction
# ─────────────────────────────────────────────────────────────────────────────
def battery_and_sensor():
    from sklearn.linear_model import Ridge
    from sklearn.metrics import mean_absolute_percentage_error
    from sklearn.model_selection import GroupKFold, GroupShuffleSplit, cross_val_predict
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import PolynomialFeatures, StandardScaler

    import battery_health
    import predictors

    m = meta("battery_life_model_metadata.json")
    life = pd.read_parquet(ML / "data" / "battery_aging" / "processed" / "isu_life.parquet").dropna(subset=["life_efc"])
    feats = m["features"]
    X, y, g = life[feats], life["life_efc"], life["group"]
    tr, te = next(GroupShuffleSplit(n_splits=1, test_size=0.05, random_state=SEED).split(X, y, g))
    mk = lambda: make_pipeline(StandardScaler(), PolynomialFeatures(2), Ridge(alpha=1.0))  # noqa: E731
    p_cv = np.exp(cross_val_predict(mk(), X.iloc[tr], np.log(y.iloc[tr]), groups=g.iloc[tr], cv=GroupKFold(10)))
    p_te = np.exp(mk().fit(X.iloc[tr], np.log(y.iloc[tr])).predict(X.iloc[te]))
    cv_mape = 100 * mean_absolute_percentage_error(y.iloc[tr], p_cv)
    te_mape = 100 * mean_absolute_percentage_error(y.iloc[te], p_te)
    st = m["all_results"]["Ridge-poly2"]
    print(f"life: reproduced CV MAPE={cv_mape:.2f} test MAPE={te_mape:.2f}  stored {st['cv_mape_pct']} / {st['test_mape_pct']}")
    assert abs(cv_mape - st["cv_mape_pct"]) < 0.05 and abs(te_mape - st["test_mape_pct"]) < 0.05

    fig, (a, b, c) = plt.subplots(1, 3, figsize=(7.2, 2.2))
    a.scatter(y.iloc[tr], p_cv, s=7, color=BLUE, alpha=0.55, lw=0, label=f"grouped CV ({len(tr)} cells)")
    a.scatter(y.iloc[te], p_te, s=16, color=ORANGE, marker="D", lw=0.4, ec="k",
              label=f"unseen conditions ({len(te)} cells)")
    lim = 1900
    xs = np.array([0, lim])
    a.plot(xs, xs, color=RED, lw=0.9, ls="--")
    a.fill_between(xs, xs * 0.7, xs * 1.3, color=RED, alpha=0.07, lw=0, label="±30 % band")
    a.set(xlim=(0, lim), ylim=(0, lim), xlabel="measured cycle life (EFC to 80 %)", ylabel="predicted cycle life (EFC)")
    a.set_title(f"(a) Cycle life (ISU-ILCC)\nMAPE: CV {cv_mape:.1f} %, test {te_mape:.1f} %")
    a.legend(loc="upper left", frameon=False, fontsize=6, handletextpad=0.2)

    # Wear factor exactly as the deployed worker computes it
    rates = np.linspace(0.5, 3.0, 26)
    for dod, col in [(20, GREEN), (50, BLUE), (80, PURPLE)]:
        wf = [battery_health._REFERENCE_LIFE / battery_health._life_efc(r, dod) for r in rates]
        b.plot(rates, wf, color=col, lw=1.4, label=f"ΔSOC = {dod} %")
    b.axhline(1.0, color=GREY, lw=0.8, ls=":")
    b.set(xlabel="charge rate (C)", ylabel="wear factor (×)")
    b.set_title("(b) Wear factor computed by the twin\n(reference: 0.5C, ΔSOC 50 %)")
    b.legend(frameon=False, loc="upper left")

    # Temperature response of the full deployed predictor (same request, only temperature changes)
    temps = np.arange(-5, 41, 1)
    now = datetime(2026, 11, 18, 10, 0)

    def req(charger, kw, t):
        return {"vehicle": {"model": "Chevy Bolt", "batteryCapacityKwh": 65, "vehicleAgeYears": 4},
                "charging": {"startSocPct": 20, "targetSocPct": 80, "chargerType": charger, "requestedRateKw": kw},
                "environment": {"temperatureC": float(t)}}

    l2 = [predictors.predict(req("Level 2", 7.2, t), now)[0]["predictions"] for t in temps]
    dc = [predictors.predict(req("DC Fast Charger", 50, t), now)[0]["predictions"] for t in temps]
    i25 = int(np.where(temps == 25)[0][0])
    i0 = int(np.where(temps == 0)[0][0])
    rel = lambda rows, key: [100 * (r[key] / rows[i25][key] - 1) for r in rows]  # noqa: E731
    c.plot(temps, rel(l2, "durationHours"), color=BLUE, lw=1.4, label="time, Level 2 7.2 kW (ML)")
    c.plot(temps, rel(dc, "durationHours"), color=ORANGE, lw=1.4, label="time, DC 50 kW (physics)")
    c.axvspan(2, 40, color=GREEN, alpha=0.07, lw=0)
    c.text(21, 47, "LM35 range", ha="center", fontsize=6, color=GREEN)
    c.axhline(0, color=GREY, lw=0.8, ls=":")
    c.set(xlabel="ambient temperature from sensor (°C)", ylabel="time change vs. 25 °C (%)")
    c.set_title("(c) Live temperature → prediction\nChevy Bolt 65 kWh, SOC 20 → 80 %")
    c.legend(frameon=False, loc="upper right", fontsize=5.8)
    for name, rows in (("L2", l2), ("DC", dc)):
        print(f"temp response {name}: 25C {rows[i25]}  0C {rows[i0]}")
    fig.tight_layout(w_pad=0.6)
    fig.savefig(OUT / "battery_sensor.pdf")
    plt.close(fig)


# ─────────────────────────────────────────────────────────────────────────────
# Figure 4 — 3D twin screenshot (cropped to the scene and the bay panel)
# ─────────────────────────────────────────────────────────────────────────────
def twin_screenshot():
    from PIL import Image
    im = Image.open(ROOT / "what_I_did" / "screenshots" / "phase9" / "01_twin_all_states_bay1_selected.png")
    im.crop((230, 165, 1340, 780)).convert("RGB").save(OUT / "twin_3d.png", optimize=True)


if __name__ == "__main__":
    which = sys.argv[1:] or ["block", "twin", "battery", "session"]
    if "block" in which:
        block_diagram()
    if "twin" in which:
        twin_screenshot()
    if "battery" in which:
        battery_and_sensor()
    if "session" in which:
        session_results()
    print("figures written to", OUT)
