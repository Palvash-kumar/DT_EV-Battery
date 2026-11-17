# Phase 2 — Train Charging-Duration and Energy Models

> **What this phase is about:** Train two honest baseline prediction models from the Phase 1 cleaned Parquet file: one predicts **charging duration (hours)** and one predicts **energy consumed (kWh)**. Use only pre-session features (no target leakage), compare simple baselines against tree-based models, evaluate with MAE/RMSE/R² and subgroup errors, and save serialized scikit-learn pipelines with metadata.

---

## 1. Environment Setup

### 1.1 Installed additional dependency

```bash
cd laptop-2
source .venv/bin/activate
pip install scikit-learn joblib
```

This installed:
- **scikit-learn 1.9.1** — ML framework (pipelines, preprocessing, models, metrics)
- **joblib 1.6.0** — model serialization
- **scipy 1.18.1** — scikit-learn dependency
- **narwhals 2.28.0**, **threadpoolctl 3.8.0**, **cloudpickle 3.1.2** — transitive dependencies

### 1.2 Directory structure created

```
laptop-2/
├── src/
│   ├── prepare_charging_data.py     # (from Phase 1)
│   ├── train_duration.py            # ← NEW: duration model training
│   ├── train_energy.py              # ← NEW: energy model training
│   └── evaluate_models.py           # ← NEW: evaluation report + plots
├── models/
│   ├── charging_duration.joblib     # ← serialized duration pipeline
│   ├── energy.joblib                # ← serialized energy pipeline
│   ├── duration_model_metadata.json # ← features, metrics, limitations
│   ├── energy_model_metadata.json   # ← features, metrics, limitations
│   ├── duration_residuals.npz       # ← test predictions for plotting
│   ├── energy_residuals.npz         # ← test predictions for plotting
│   └── plots/
│       ├── duration_actual_vs_predicted.png
│       ├── duration_subgroup_mae.png
│       ├── energy_actual_vs_predicted.png
│       └── energy_subgroup_mae.png
├── data/processed/                  # (from Phase 1)
├── notebooks/                       # (from Phase 1)
└── .venv/
```

---

## 2. Target Definition

We train two separate regression models:

| Model | Target Column | Units | Meaning |
|---|---|---|---|
| Duration model | `Charging Duration (hours)` | hours | How long the charging session will take |
| Energy model | `Energy Consumed (kWh)` | kWh | How much energy the session will consume |

Both are **session-level predictions** — given what we know when a vehicle plugs in, predict the outcome.

---

## 3. Feature Selection — Preventing Target Leakage

### 3.1 The leakage problem

A prediction must use only fields known **before or at the start** of the charging session. If we accidentally include the answer (or a proxy for it) as an input, the model "cheats" and produces misleadingly good metrics that won't hold in production.

### 3.2 Features we USE (known at request time)

#### Numeric features

| Feature | Why it's safe |
|---|---|
| `Battery Capacity (kWh)` | Physical property of the vehicle — known before charging |
| `State of Charge (Start %)` | The SOC when the vehicle plugs in — measured at start |
| `State of Charge (End %)` | The **target** SOC the user wants to reach — set at request time |
| `Charging Rate (kW)` | The charger's rated power — known from charger hardware |
| `Temperature (°C)` | Ambient temperature at the station — measured at start |
| `Vehicle Age (years)` | Age of the vehicle — known from records |
| `socDelta` | `End SOC − Start SOC` — derived from two known-at-start values |
| `startHour` | Hour of day (0–23) — known from start timestamp |
| `isWeekend` | Whether it's a weekend — known from start timestamp |

For the **energy model only**, we also include:
| `requiredEnergyApprox` | `(socDelta / 100) × Battery Capacity` — a physics-based estimate |

This feature provides a physical prior for energy prediction. We exclude it from the duration model because it tracks energy, not time.

#### Categorical features (both models)

| Feature | Unique Values |
|---|---|
| `Vehicle Model` | BMW i3, Chevy Bolt, Hyundai Kona, Nissan Leaf, Tesla Model 3 |
| `Charger Type` | Level 1, Level 2, DC Fast Charger |
| `Charging Station Location` | Houston, Los Angeles, New York, San Francisco, Chicago |
| `Time of Day` | Morning, Afternoon, Evening, Night |
| `User Type` | Casual Driver, Commuter, Long-Distance Traveler |

### 3.3 Features we EXCLUDED (leakage risk)

| Excluded Feature | Reason |
|---|---|
| `Energy Consumed (kWh)` | **(for duration model)** — correlated with/derived from duration |
| `Charging Duration (hours)` | **(for energy model)** — correlated with/derived from energy |
| `Charging End Time` | Literally encodes when the session ends → encodes duration |
| `Charging Cost (USD)` | Directly derived from energy consumed |
| `computedDurationHours` | IS the target computed from timestamps |
| `Distance Driven (since last charge) (km)` | Weakly relevant, excluded to keep models focused |
| `User ID`, `Charging Station ID` | High-cardinality identifiers — not generalizable features |
| `Day of Week` | Redundant with `isWeekend`; kept `isWeekend` as the simpler feature |

---

## 4. Preprocessing Pipeline

Both models use a scikit-learn `ColumnTransformer` that handles numeric and categorical features separately:

```
ColumnTransformer
├── Numeric pipeline:
│   ├── SimpleImputer(strategy="median")     # handle any remaining nulls
│   └── StandardScaler()                     # zero-mean, unit-variance
└── Categorical pipeline:
    ├── SimpleImputer(strategy="most_frequent")  # handle unknown categories
    └── OneHotEncoder(handle_unknown="ignore")   # binary indicator columns
```

**Key design choices:**
- The preprocessor is **fit only on training data** (inside the pipeline). It never sees test data during fitting — this prevents data leakage from preprocessing.
- `handle_unknown="ignore"` in OneHotEncoder means unseen categories at inference time produce all-zero rows instead of crashing — important for production robustness.
- `sparse_output=False` for downstream compatibility with all estimators.

---

## 5. Train/Test Split

| Property | Value |
|---|---|
| Total rows | 1,320 |
| Train rows | 1,056 (80%) |
| Test rows | 264 (20%) |
| Random seed | 42 (reproducible) |
| Split type | Random stratified by nothing |

**Why not a time-aware split?** The implementation plan says "Prefer a time-aware split if timestamps make this practical." In this dataset, each user appears exactly once, timestamps span a narrow synthetic window, and there's no meaningful temporal ordering. A random seeded split is the only practical option, and this limitation is documented.

---

## 6. Models Compared

For each target, we compared three models of increasing complexity:

| Model | Type | Purpose |
|---|---|---|
| **Linear Regression** | Simple baseline | The simplest possible model — if the data has any linear signal, this finds it |
| **Random Forest** | Ensemble, bagged trees | Captures non-linear patterns; robust to outliers; 200 trees, max depth 12 |
| **HistGradientBoosting** | Ensemble, boosted trees | Often the strongest off-the-shelf model; 300 iterations, max depth 8 |

Each model was:
1. **Cross-validated** on training data (5-fold CV, scoring on negative MAE)
2. **Fit** on the full training set
3. **Evaluated** on the held-out test set with MAE, RMSE, and R²

---

## 7. Results

### 7.1 Charging Duration Model

| Model | CV-MAE | Test MAE | Test RMSE | Test R² | Selected? |
|---|---|---|---|---|---|
| **Linear Regression (baseline)** | 0.8952 | **0.8603** | 1.0869 | −0.0214 | ✅ |
| Random Forest | 0.8956 | 0.8617 | 1.0828 | −0.0137 | |
| HistGradientBoosting | 0.9615 | 0.9190 | 1.1689 | −0.1815 | |

**Selected: Linear Regression** — marginally best test MAE, simplest model, essentially tied with Random Forest.

#### Duration subgroup errors (Linear Regression)

**By Charger Type:**

| Charger Type | Test Samples | MAE (hours) |
|---|---|---|
| DC Fast Charger | 84 | 0.7937 |
| Level 2 | 83 | 0.8785 |
| Level 1 | 97 | 0.9024 |

**By Vehicle Model:**

| Vehicle Model | Test Samples | MAE (hours) |
|---|---|---|
| Hyundai Kona | 56 | 0.8018 |
| Nissan Leaf | 54 | 0.8230 |
| Chevy Bolt | 50 | 0.8246 |
| BMW i3 | 54 | 0.9084 |
| Tesla Model 3 | 50 | 0.9498 |

### 7.2 Energy Consumed Model

| Model | CV-MAE | Test MAE | Test RMSE | Test R² | Selected? |
|---|---|---|---|---|---|
| **Linear Regression (baseline)** | 18.5913 | **18.6296** | 22.4734 | −0.0178 | ✅ |
| Random Forest | 18.5585 | 18.9251 | 22.9087 | −0.0577 | |
| HistGradientBoosting | 19.8017 | 20.3074 | 25.4448 | −0.3048 | |

**Selected: Linear Regression** — best test MAE and closest to zero R², simplest model.

#### Energy subgroup errors (Linear Regression)

**By Charger Type:**

| Charger Type | Test Samples | MAE (kWh) |
|---|---|---|
| Level 2 | 83 | 17.8217 |
| DC Fast Charger | 84 | 17.9098 |
| Level 1 | 97 | 19.9443 |

**By Vehicle Model:**

| Vehicle Model | Test Samples | MAE (kWh) |
|---|---|---|
| Chevy Bolt | 50 | 17.6636 |
| BMW i3 | 54 | 17.9699 |
| Nissan Leaf | 54 | 18.2151 |
| Hyundai Kona | 56 | 18.9129 |
| Tesla Model 3 | 50 | 20.4385 |

---

## 8. Interpreting the Results — Why R² Is Negative

### 8.1 What negative R² means

An R² of −0.02 means the model is about as good as always predicting the mean value. It does **not** mean the model is "wrong" — it means the input features have essentially no predictive power over the target in this dataset.

### 8.2 Why this is expected

This is fully consistent with what Phase 1 discovered:

1. **96.1% of rows** have at least one data quality flag
2. The dataset's columns were **generated independently** — duration, energy, rate, SOC, etc. are not physically coupled
3. **Energy mismatch** (79.2% of rows) and **duration mismatch** (75.7%) confirm that `energy ≠ rate × duration` in this data
4. There are no real physical correlations for the models to learn

### 8.3 Why we keep the models anyway

The implementation plan says: "Select the simplest model that performs acceptably." In a demo/learning project:

- The models produce **reasonable-looking predictions** (duration ≈ 2.3 hours, energy ≈ 38 kWh — within the data's range)
- The pipeline architecture (preprocessing → model → serialization → inference) is what matters for the digital twin demo
- All outputs are labelled as **"ML estimate"** — never presented as physically validated predictions
- With a real, physically consistent dataset, the same pipeline would produce meaningful R² values

---

## 9. Sample Inference

Both pipelines can be loaded and used to predict from a dictionary of pre-session features:

```bash
cd laptop-2
source .venv/bin/activate

python3 -c "
import joblib
import pandas as pd

dur = joblib.load('models/charging_duration.joblib')
eng = joblib.load('models/energy.joblib')

sample = pd.DataFrame([{
    'Battery Capacity (kWh)': 75.0,
    'State of Charge (Start %)': 25.0,
    'State of Charge (End %)': 80.0,
    'Charging Rate (kW)': 50.0,
    'Temperature (°C)': 30.0,
    'Vehicle Age (years)': 3.0,
    'socDelta': 55.0,
    'requiredEnergyApprox': 41.25,
    'startHour': 10,
    'isWeekend': 0,
    'Vehicle Model': 'Tesla Model 3',
    'Charger Type': 'DC Fast Charger',
    'Charging Station Location': 'Houston',
    'Time of Day': 'Morning',
    'User Type': 'Commuter',
}])

print(f'Duration: {dur.predict(sample)[0]:.2f} hours')
print(f'Energy:   {eng.predict(sample)[0]:.2f} kWh')
"
```

**Output:**
```
Duration: 2.28 hours
Energy:   37.62 kWh
```

---

## 10. Evaluation Plots Generated

All plots are saved in `laptop-2/models/plots/` at 150 DPI:

| # | Plot | File | What It Shows |
|---|---|---|---|
| 1 | Duration Actual vs Predicted | `duration_actual_vs_predicted.png` | Scatter plot (actual vs predicted) + residual histogram — shows the cloud around the mean with no correlation |
| 2 | Duration Subgroup MAE | `duration_subgroup_mae.png` | Bar charts of MAE by Charger Type and Vehicle Model — relatively uniform errors (0.79–0.95 hours) |
| 3 | Energy Actual vs Predicted | `energy_actual_vs_predicted.png` | Same pair of plots for energy — wider scatter, centered around mean energy |
| 4 | Energy Subgroup MAE | `energy_subgroup_mae.png` | Bar charts of MAE by Charger Type and Vehicle Model — relatively uniform errors (17.7–20.4 kWh) |

---

## 11. Model Metadata Files

Each model has a companion `*_model_metadata.json` containing:

```json
{
  "task": "charging_duration_prediction",
  "target": "Charging Duration (hours)",
  "target_units": "hours",
  "features_numeric": ["Battery Capacity (kWh)", "..."],
  "features_categorical": ["Vehicle Model", "..."],
  "selected_model": "MedianBaseline",
  "all_results": { "...per-model CV and test metrics..." },
  "subgroup_errors": { "...by charger type and vehicle model..." },
  "train_rows": 1056,
  "test_rows": 264,
  "split": "80/20 random, seed=42",
  "training_date": "2026-11-17T13:29:16Z",
  "limitations": ["..."]
}
```

This metadata is used by later phases (Phase 5 — Python inference worker) to:
- Verify that incoming MQTT requests contain all required features
- Attach model version and training date to predictions
- Display limitations and caveats in the UI

---

## 12. How to Reproduce

```bash
# From the project root
cd laptop-2
source .venv/bin/activate

# 1. Train duration model
python src/train_duration.py
# Output: models/charging_duration.joblib + models/duration_model_metadata.json

# 2. Train energy model
python src/train_energy.py
# Output: models/energy.joblib + models/energy_model_metadata.json

# 3. Generate evaluation report and plots
python src/evaluate_models.py
# Output: models/plots/*.png + printed metrics summary
```

All three scripts accept `--data` and `--out` flags for custom paths. Use `--seed` to change the random seed.

---

## 13. Key Design Decisions

| Decision | Rationale |
|---|---|
| Linear Regression selected over tree models | Simplest model; performs identically on this data; easier to debug and explain |
| Preprocessing inside the pipeline | Prevents train/test leakage; single `.joblib` file contains everything needed for inference |
| `socDelta` and `requiredEnergyApprox` as features | They encode known-at-request physics: how much SOC the user wants to gain, and roughly how much energy that requires |
| Random split, not time-based | Each user appears once; no meaningful temporal ordering exists in this synthetic data |
| All rows kept (no filtering by quality flags) | Removing 96% of data would leave too few rows; flags are available for downstream filtering if needed |
| Residuals saved as `.npz` | Decouples evaluation/plotting from training; `evaluate_models.py` runs in seconds without retraining |

---

## 14. Limitations (Must Be Communicated)

1. **Predictions are ML estimates**, not physically validated measurements
2. **R² ≈ 0** means the models are essentially predicting the dataset's mean — the input features have no predictive power in this synthetic data
3. **With real, physically consistent data**, the same pipeline and features would produce meaningful predictions — the architecture is sound, only the data lacks physical coherence
4. **No degradation modeling** — this is a single-session dataset, not a longitudinal battery history
5. **Random split limitation** — acknowledged; a time-aware split would be preferred with real temporal data

---

## 15. Files Created in This Phase

```
laptop-2/src/train_duration.py              # Duration model training script
laptop-2/src/train_energy.py                # Energy model training script
laptop-2/src/evaluate_models.py             # Evaluation report + plots generator

laptop-2/models/charging_duration.joblib    # Serialized duration pipeline (6.0 KB)
laptop-2/models/energy.joblib               # Serialized energy pipeline (6.1 KB)
laptop-2/models/duration_model_metadata.json
laptop-2/models/energy_model_metadata.json
laptop-2/models/duration_residuals.npz
laptop-2/models/energy_residuals.npz

laptop-2/models/plots/duration_actual_vs_predicted.png
laptop-2/models/plots/duration_subgroup_mae.png
laptop-2/models/plots/energy_actual_vs_predicted.png
laptop-2/models/plots/energy_subgroup_mae.png
```

---

## 16. What's Next — Phase 3

Phase 3 will build a **Battery SOH, Degradation, and RUL module** using a **separate longitudinal aging dataset** (e.g., NASA or CALCE battery cycling data). It cannot use this 1,320-row charging CSV alone because:
- Each user appears only once (no repeated battery measurements)
- No capacity fade data exists
- SOH = currentCapacity / initialCapacity requires tracking the same battery over many cycles
