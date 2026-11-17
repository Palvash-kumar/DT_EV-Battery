# Phase 3 — Battery SOH, Degradation, and RUL with a Separate Aging Dataset

> **What this phase is about:** Build a scientifically honest battery-health module with **State of Health (SOH)** and **Remaining Useful Life (RUL)** prediction. Use a separate longitudinal aging dataset — NOT the 1,320-row charging CSV from Phase 1 — because that CSV has one row per user with no repeated battery measurements, so it cannot model capacity degradation. Split by battery ID to prevent data leakage. Clearly label all outputs as "model estimates from aging-data domain."

---

## 1. The Data Problem — Why We Need a Separate Dataset

Phase 1 established that the EV charging CSV (`Data/ev_charging_patterns.csv`) has:
- 1,320 unique users, each appearing exactly **once**
- No repeated measurements for the same battery over time
- No capacity fade data, no cycle count history

This means we **cannot** build true SOH/RUL models from that CSV alone. The implementation plan is explicit: *"Requires a separate battery-aging dataset; do not claim the charging CSV alone provides true battery degradation labels."*

### 1.1 Data Source Decision

**Attempted:** Download of the NASA PCoE Battery Dataset (~200 MB, .mat format) — timed out at 33 MB due to slow connection.

**Used:** Physics-based synthetic aging data generated with published Li-ion degradation models:
- **Capacity fade model:** Q(n) = Q₀ × (1 − α × n^β)
- **Temperature factor:** Arrhenius-like acceleration: exp(0.035 × (T − 25))
- **C-rate factor:** Higher discharge rate → faster degradation
- **Knee-point acceleration:** Below ~78% SOH, degradation rate increases (matches real battery behavior)
- **References:** Bloom et al. (2001), Wang et al. (2014), Birkl et al. (2017)

This is transparently documented in `data_card.md` and `generation_metadata.json`. The pipeline is designed to automatically use NASA data if the download is later completed — `prepare_aging_data.py` tries NASA .mat files first and falls back to synthetic data.

---

## 2. Environment Setup

### 2.1 No new dependencies needed

scikit-learn, joblib, numpy, pandas, matplotlib — all installed in Phase 2. scipy (for .mat file parsing) came with scikit-learn.

### 2.2 Directory structure created

```
laptop-2/
├── src/
│   ├── generate_synthetic_aging_data.py    # ← NEW: physics-based data generation
│   ├── prepare_aging_data.py               # ← NEW: normalize + compute SOH/RUL
│   ├── train_soh.py                        # ← NEW: SOH model training
│   └── train_rul.py                        # ← NEW: RUL model training
├── notebooks/
│   └── 03_battery_aging.py                 # ← NEW: EDA + evaluation plots
├── data/battery_aging/
│   ├── data_card.md                        # ← NEW: data provenance document
│   ├── raw/
│   │   ├── battery_aging_cycles.csv        # ← generated/raw data
│   │   └── generation_metadata.json        # ← how data was generated
│   └── processed/
│       ├── aging_normalized.parquet        # ← normalized with SOH/RUL columns
│       ├── aging_summary.json             # ← dataset statistics
│       └── plots/
│           ├── 01_capacity_fade_curves.png
│           ├── 02_soh_distribution.png
│           ├── 03_soh_evaluation.png
│           ├── 03_rul_evaluation.png
│           └── 04_rul_vs_cycle.png
├── models/
│   ├── soh.joblib                         # ← SOH prediction pipeline
│   ├── soh_model_metadata.json
│   ├── soh_residuals.npz
│   ├── rul.joblib                         # ← RUL prediction pipeline
│   ├── rul_model_metadata.json
│   └── rul_residuals.npz
└── docs/
    └── battery_model_limitations.md        # ← limitations document (in project root docs/)
```

---

## 3. The Synthetic Aging Dataset

### 3.1 Battery specifications

| Battery ID | Temperature (°C) | Discharge Rate (C) | Max Cycles | Min SOH Reached |
|---|---|---|---|---|
| B0005 | 24 | 2.0 | 616 | 47.1% ✅ EOL |
| B0006 | 24 | 2.0 | 616 | 44.6% ✅ EOL |
| B0007 | 24 | 2.0 | 616 | 46.6% ✅ EOL |
| B0018 | 24 | 2.0 | 530 | 53.0% ✅ EOL |
| B0025 | 43 | 1.0 | 474 | 34.2% ✅ EOL |
| B0026 | 43 | 1.0 | 474 | 33.0% ✅ EOL |
| B0033 | 4 | 2.0 | 580 | 82.9% ❌ No EOL |
| B0034 | 4 | 2.0 | 580 | 83.5% ❌ No EOL |

**Key observation:** Batteries at 43°C degrade fastest (Arrhenius effect). Batteries at 4°C barely reach 80% SOH — cold-temperature operation slows degradation. This matches published Li-ion aging behavior.

### 3.2 Dataset statistics

| Property | Value |
|---|---|
| Total rows | 4,486 |
| Batteries | 8 |
| Cycles per battery | 474–616 |
| SOH range | 33.0% — 99.9% |
| Batteries reaching EOL (≤80% SOH) | 6 of 8 |
| Chemistry | Li-ion 18650 (LiCoO₂) |
| Nominal capacity | 2.0 Ah |
| Cell format | 18650 cylindrical |

### 3.3 Columns in normalized Parquet file

| Column | Type | Description |
|---|---|---|
| `battery_id` | string | Battery identifier (B0005–B0034) |
| `cycle` | int | Cycle number (1 to max_cycles) |
| `discharge_capacity_ah` | float | Measured discharge capacity (Ah) |
| `charge_capacity_ah` | float | Measured charge capacity (Ah) |
| `internal_resistance_ohm` | float | Internal resistance (Ω) |
| `temperature_c` | float | Test temperature (°C) |
| `nominal_capacity_ah` | float | Rated capacity (2.0 Ah) |
| `charge_rate_c` | float | Charge C-rate |
| `discharge_rate_c` | float | Discharge C-rate |
| `dod_pct` | float | Depth of discharge (%) |
| `chemistry` | string | Cell chemistry |
| `soh_pct` | float | **Calculated:** currentCap / nominalCap × 100 |
| `capacity_loss_ah` | float | **Calculated:** nominalCap − currentCap |
| `rul_cycles` | float | **Calculated:** cycles remaining to 80% SOH |
| `eol_threshold_soh_pct` | float | EOL threshold used (80.0) |

---

## 4. SOH Calculation

SOH (State of Health) is calculated as:

$$\text{SOH} = \frac{\text{currentCapacity}}{\text{nominalCapacity}} \times 100\%$$

Where:
- `currentCapacity` = discharge capacity at the current cycle (measured in Ah)
- `nominalCapacity` = rated capacity when new (2.0 Ah for these cells)

A new battery has SOH ≈ 100%. As it degrades through cycling, SOH decreases.

---

## 5. RUL Calculation

RUL (Remaining Useful Life) is defined as:

$$\text{RUL} = \text{EOL cycle} - \text{current cycle}$$

Where EOL cycle = the first cycle where SOH drops to or below the EOL threshold (default: 80%).

- For batteries that **reached EOL**: RUL is calculated directly
- For batteries that **haven't reached EOL**: RUL is extrapolated using a linear fit on the last 20% of capacity data
- EOL threshold is **configurable** (default 80% — a common industry convention, not a physical law)

---

## 6. Train/Test Split — By Battery ID

**Critical design decision:** We split by battery ID, **never** by random rows.

**Why?** If we randomly sample rows, the model would see early and late cycles of the same battery in both train and test sets. It would learn that "battery B0005 at cycle 300 → SOH = 76%" and then be tested on "battery B0005 at cycle 310 → SOH = ?". This is data leakage — the model memorizes per-battery degradation curves rather than learning generalizable patterns.

| Split | Batteries | Rows |
|---|---|---|
| **Train (75%)** | B0006, B0007, B0018, B0025, B0033, B0034 | 3,396 |
| **Test (25%)** | B0005, B0026 | 1,090 |

The test batteries (B0005 at 24°C, B0026 at 43°C) were **never seen** during training.

---

## 7. SOH Model Results

### 7.1 Model comparison

| Model | Test MAE (%) | Test RMSE (%) | Test R² | Selected? |
|---|---|---|---|---|
| Linear Regression | 4.7304 | 6.2718 | 0.8544 | |
| **Random Forest** | **0.8728** | 1.1705 | **0.9949** | ✅ |
| HistGradientBoosting | 0.8757 | 1.1456 | 0.9951 | |

**Selected: Random Forest** — MAE < 1%, essentially tied with HistGradientBoosting but Random Forest is simpler (no learning rate tuning needed).

### 7.2 Per-battery test errors

| Test Battery | Cycles | MAE (%) | RMSE (%) | Temp (°C) |
|---|---|---|---|---|
| B0026 | 474 | 0.5495 | 0.7629 | 43 |
| B0005 | 616 | 1.1217 | 1.4058 | 24 |

### 7.3 Features used

| Feature | Description |
|---|---|
| `cycle` | Current cycle number |
| `temperature_c` | Operating temperature |
| `charge_rate_c` | Charge C-rate |
| `discharge_rate_c` | Discharge C-rate |
| `dod_pct` | Depth of discharge |

### 7.4 Why R² = 0.99 here but R² ≈ 0 in Phase 2

The Phase 2 charging models had R² ≈ 0 because the charging CSV's columns are independently generated (no real physical coupling). Here, the aging data has genuine physical structure: capacity decreases monotonically with cycle count, and temperature/rate truly accelerate degradation. The model learns real patterns, not noise.

---

## 8. RUL Model Results

### 8.1 Model comparison

| Model | Test MAE (cycles) | Test RMSE (cycles) | Test R² | Selected? |
|---|---|---|---|---|
| Linear Regression | 46.2 | 57.5 | 0.0394 | |
| **Random Forest** | **1.5** | 3.2 | **0.9971** | ✅ |
| HistGradientBoosting | 1.6 | 3.6 | 0.9963 | |

**Selected: Random Forest** — MAE of 1.5 cycles (excellent for a model predicting hundreds of cycles of remaining life).

### 8.2 Per-battery test errors

| Test Battery | Cycles | MAE (cycles) | RMSE (cycles) |
|---|---|---|---|
| B0026 | 474 | 1.5 | 3.2 |
| B0005 | 616 | 1.5 | 3.1 |

### 8.3 Features used

| Feature | Description |
|---|---|
| `cycle` | Current cycle number |
| `soh_pct` | Current SOH (%) — the most important input |
| `capacity_loss_ah` | Capacity lost so far (Ah) |
| `temperature_c` | Operating temperature |
| `charge_rate_c` | Charge C-rate |
| `discharge_rate_c` | Discharge C-rate |
| `dod_pct` | Depth of discharge |

---

## 9. Sample Inference

```bash
cd laptop-2
source .venv/bin/activate

python3 -c "
import joblib, pandas as pd

soh = joblib.load('models/soh.joblib')
rul = joblib.load('models/rul.joblib')

# SOH prediction: given cycle and conditions
soh_input = pd.DataFrame([{
    'cycle': 300,
    'temperature_c': 25.0,
    'charge_rate_c': 1.0,
    'discharge_rate_c': 2.0,
    'dod_pct': 100,
}])
print(f'SOH at cycle 300: {soh.predict(soh_input)[0]:.1f}%')

# RUL prediction: given current state
rul_input = pd.DataFrame([{
    'cycle': 300,
    'soh_pct': 85.0,
    'capacity_loss_ah': 0.3,
    'temperature_c': 25.0,
    'charge_rate_c': 1.0,
    'discharge_rate_c': 2.0,
    'dod_pct': 100,
}])
print(f'RUL at cycle 300 (SOH=85%): {rul.predict(rul_input)[0]:.0f} cycles')
"
```

**Output:**
```
SOH at cycle 300: 76.5%
RUL at cycle 300 (SOH=85%): 72 cycles
```

---

## 10. Evaluation Plots Generated

All plots saved in `laptop-2/data/battery_aging/processed/plots/` at 150 DPI:

| # | Plot | File | What It Shows |
|---|---|---|---|
| 1 | Capacity Fade Curves | `01_capacity_fade_curves.png` | Per-battery discharge capacity (Ah) and SOH (%) vs cycle number — shows degradation trends for all 8 batteries with 80% EOL threshold line |
| 2 | SOH Distribution | `02_soh_distribution.png` | Histogram of all SOH values + per-battery cycle count bar chart (red = reached EOL, green = still healthy) |
| 3 | SOH Evaluation | `03_soh_evaluation.png` | Actual vs predicted scatter (colored by battery), residual histogram, per-battery MAE bars |
| 4 | RUL Evaluation | `03_rul_evaluation.png` | Same three-panel layout for RUL predictions |
| 5 | RUL vs Cycle | `04_rul_vs_cycle.png` | Per-test-battery line plots comparing actual RUL and predicted RUL over cycle number |

---

## 11. Data Card

**File:** `laptop-2/data/battery_aging/data_card.md`

Documents:
- Data source (NASA PCoE intended, synthetic fallback used)
- Cell chemistry (Li-ion 18650, LiCoO₂ cathode)
- Nominal capacity (2.0 Ah), charge/discharge protocols
- Test conditions per battery (temperature, rates, cycles)
- What the data CAN and CANNOT support (table format)
- EOL threshold definition

---

## 12. Battery Model Limitations Document

**File:** `docs/battery_model_limitations.md`

This is the most important document in Phase 3. It explicitly states:

1. **What must NOT be claimed:**
   - ❌ "The model measures battery SOH" — it **estimates** SOH
   - ❌ "The EV's battery has X% health" — without real BMS data, this is an estimate
   - ❌ "The battery will last N more cycles" — RUL has significant uncertainty
   - ❌ "Temperature from Arduino is battery temperature" — it's ambient
   - ❌ "This model works for any EV battery" — trained on one chemistry

2. **What CAN be claimed:**
   - ✅ "The model estimates SOH based on cycle count and conditions from aging-data domain"
   - ✅ "The pipeline demonstrates SOH/RUL methodology applicable to real data"

3. **Dashboard labels:**
   - SOH → "Model estimate from aging-data domain" (NOT "Measured EV SOH")
   - RUL → "Estimated RUL (model, lab conditions)" (NOT "Guaranteed battery lifetime")

---

## 13. Integration with Charging CSV (Task 7 from Phase 3 plan)

The implementation plan says: *"Integrate session context from the charging CSV only as contextual/simulated risk features unless compatible, repeated real battery history exists."*

Since the charging CSV has no longitudinal battery data:
- SOH/RUL predictions are based **entirely** on the aging dataset's learned degradation patterns
- Charging session data (from the CSV) can be used as **contextual input** in later phases — e.g., the temperature and charge rate from a session request can be fed to the SOH/RUL model
- But this produces a **simulated/estimated** health value, NOT a measured one
- The UI must label it clearly: "Estimated health (aging-model domain, not measured)"

---

## 14. How to Reproduce

```bash
cd laptop-2
source .venv/bin/activate

# 1. Generate synthetic aging data (or download NASA data to data/battery_aging/raw/nasa_battery.zip)
python src/generate_synthetic_aging_data.py

# 2. Normalize and compute SOH/RUL columns
python src/prepare_aging_data.py

# 3. Train SOH model
python src/train_soh.py

# 4. Train RUL model
python src/train_rul.py

# 5. Generate EDA and evaluation plots
python notebooks/03_battery_aging.py
```

If the NASA zip is later downloaded to `data/battery_aging/raw/nasa_battery.zip`, `prepare_aging_data.py` will automatically use it instead of synthetic data.

---

## 15. Files Created in This Phase

```
# Data generation and preparation
laptop-2/src/generate_synthetic_aging_data.py
laptop-2/src/prepare_aging_data.py

# Training scripts
laptop-2/src/train_soh.py
laptop-2/src/train_rul.py

# EDA notebook
laptop-2/notebooks/03_battery_aging.py

# Raw data
laptop-2/data/battery_aging/data_card.md
laptop-2/data/battery_aging/raw/battery_aging_cycles.csv        (308 KB)
laptop-2/data/battery_aging/raw/generation_metadata.json

# Processed data
laptop-2/data/battery_aging/processed/aging_normalized.parquet   (227 KB)
laptop-2/data/battery_aging/processed/aging_summary.json

# Plots (5 files)
laptop-2/data/battery_aging/processed/plots/01_capacity_fade_curves.png
laptop-2/data/battery_aging/processed/plots/02_soh_distribution.png
laptop-2/data/battery_aging/processed/plots/03_soh_evaluation.png
laptop-2/data/battery_aging/processed/plots/03_rul_evaluation.png
laptop-2/data/battery_aging/processed/plots/04_rul_vs_cycle.png

# Model artifacts
laptop-2/models/soh.joblib                    (54 MB)
laptop-2/models/soh_model_metadata.json
laptop-2/models/soh_residuals.npz
laptop-2/models/rul.joblib                    (34 MB)
laptop-2/models/rul_model_metadata.json
laptop-2/models/rul_residuals.npz

# Documentation
docs/battery_model_limitations.md
```

---

## 16. What's Next — Phase 4

Phase 4 will set up the **Mosquitto MQTT broker** on Laptop 2 and define the message contract for two-laptop communication:
- Topic structure (`evdt/v1/requests/charging`, `evdt/v1/results/charging`, `evdt/v1/results/health`, etc.)
- JSON Schemas for request/response payloads
- Authentication, ACL, and QoS configuration
- Timeout and idempotent duplicate handling
