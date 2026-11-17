# Phase 1 — Inspect, Clean, and Explore the Charging Dataset

> **What this phase is about:** Take the raw 1,320-row CSV (`Data/ev_charging_patterns.csv`), understand its shape and quality, validate it against physical domain rules, flag problems transparently (never silently fix or delete), derive useful features for later ML phases, generate EDA visualizations, and save a cleaned Parquet file ready for model training.

---

## 1. Environment Setup

### 1.1 Created a Python virtual environment

```bash
cd laptop-2
python3 -m venv .venv
source .venv/bin/activate
```

### 1.2 Installed required packages

```bash
pip install pandas numpy matplotlib seaborn pyarrow jupyter
```

These are the only dependencies needed for data work. `pyarrow` is specifically for Parquet read/write support.

### 1.3 Created directory structure

```
laptop-2/
├── src/                              # Python scripts
│   └── prepare_charging_data.py      # ← main cleaning pipeline
├── notebooks/
│   ├── 01_data_quality_eda.py        # ← EDA script (headless, generates PNGs)
│   └── 01_data_quality_eda.ipynb     # ← same analysis as Jupyter notebook
├── data/
│   └── processed/
│       ├── charging_clean.parquet    # ← cleaned output (1,320 rows × 27 cols)
│       ├── cleaning_summary.json    # ← machine-readable cleaning report
│       ├── data_dictionary.md       # ← human-readable column reference
│       └── plots/                   # ← 8 EDA visualizations
│           ├── 01_missingness.png
│           ├── 02_duration_energy_dist.png
│           ├── 03_energy_by_model_charger.png
│           ├── 04_rate_vs_temperature.png
│           ├── 05_soc_delta_vs_energy.png
│           ├── 06_time_of_day_demand.png
│           ├── 07_data_quality_flags.png
│           └── 08_correlation_matrix.png
└── .venv/                           # Python virtual environment (not in Git)
```

---

## 2. The Raw Dataset — What We Started With

**File:** `Data/ev_charging_patterns.csv` (this file is NEVER modified)

| Property | Value |
|---|---|
| Rows | 1,320 |
| Columns | 20 |
| Duplicate rows | 0 |
| Total null cells | 198 (across 3 columns, 66 each) |

### 2.1 The 20 original columns

| # | Column Name | Data Type | Example Value |
|---|---|---|---|
| 1 | User ID | string | User_1 |
| 2 | Vehicle Model | string | Tesla Model 3 |
| 3 | Battery Capacity (kWh) | float | 108.46 |
| 4 | Charging Station ID | string | Station_391 |
| 5 | Charging Station Location | string | Houston |
| 6 | Charging Start Time | datetime | 2024-01-01 00:00:00 |
| 7 | Charging End Time | datetime | 2024-01-01 00:39:00 |
| 8 | Energy Consumed (kWh) | float | 60.71 |
| 9 | Charging Duration (hours) | float | 0.59 |
| 10 | Charging Rate (kW) | float | 36.39 |
| 11 | Charging Cost (USD) | float | 13.09 |
| 12 | Time of Day | string | Evening |
| 13 | Day of Week | string | Tuesday |
| 14 | State of Charge (Start %) | float | 29.37 |
| 15 | State of Charge (End %) | float | 86.12 |
| 16 | Distance Driven (since last charge) (km) | float | 293.60 |
| 17 | Temperature (°C) | float | 27.95 |
| 18 | Vehicle Age (years) | float | 2.0 |
| 19 | Charger Type | string | DC Fast Charger |
| 20 | User Type | string | Commuter |

### 2.2 Categorical values discovered

| Column | Unique Values |
|---|---|
| Vehicle Model | BMW i3, Chevy Bolt, Hyundai Kona, Nissan Leaf, Tesla Model 3 (5 models) |
| Charging Station Location | Houston, Los Angeles, New York, San Francisco, Chicago (5 cities) |
| Time of Day | Morning, Afternoon, Evening, Night (4 categories) |
| Day of Week | Monday through Sunday (7 days) |
| Charger Type | Level 1, Level 2, DC Fast Charger (3 types) |
| User Type | Casual Driver, Commuter, Long-Distance Traveler (3 types) |
| Charging Station ID | 462 unique station IDs |
| User ID | 1,320 unique (one per row — each user appears exactly once) |

### 2.3 Columns with null values

| Column | Null Count | Percentage |
|---|---|---|
| Energy Consumed (kWh) | 66 | 5.0% |
| Charging Rate (kW) | 66 | 5.0% |
| Distance Driven (since last charge) (km) | 66 | 5.0% |

All other 17 columns have zero nulls.

---

## 3. The Cleaning Script — `prepare_charging_data.py`

**File:** `laptop-2/src/prepare_charging_data.py`

This is the main reproducible pipeline. It does four things in order: **Load → Validate → Derive Features → Impute & Save**.

### 3.1 Loading (`load_raw` function)

- Reads the CSV with explicit `parse_dates` for the two timestamp columns (`Charging Start Time`, `Charging End Time`) so pandas parses them as proper `datetime64` objects, not strings.
- Checks that all 20 expected columns exist — exits immediately if any column is missing (guards against schema drift if the CSV is ever replaced).

### 3.2 Profiling (`profile` function)

- Counts nulls per column, total nulls, duplicate rows
- Records data types, numeric min/max ranges, and categorical unique counts
- This profile is saved into `cleaning_summary.json` so we have a snapshot of what the raw data looked like

### 3.3 Validation (`validate` function)

This is the core data quality step. For every row, it checks 7 domain rules and appends flag strings to a list. At the end, all flags are joined with `|` into a single `dataQualityFlag` column.

**The 7 validation rules:**

| # | Rule | Flag Name | What It Catches |
|---|---|---|---|
| 1 | Battery Capacity must be > 0 | `battery_capacity_le_0` | Zero or negative battery capacity |
| 2 | Start SOC must not be negative | `start_soc_negative` | Physically impossible negative charge state |
| 3 | End SOC must be ≤ 100% | `end_soc_gt_100` | SOC above 100% is physically impossible |
| 4 | Start SOC must be < End SOC | `start_soc_gte_end_soc` | Charging should increase SOC, not decrease it |
| 5 | Energy, duration, rate, cost must be ≥ 0 | `energy_negative`, `duration_negative`, `rate_negative`, `cost_negative` | Negative values for positive-only quantities |
| 6 | End time must be after start time | `end_before_or_equal_start` | Timestamps that don't make physical sense |
| 7 | Recorded duration vs computed duration (from timestamps) must agree within 20% | `duration_mismatch_gt_20pct` | The CSV's `Charging Duration` column doesn't match `End Time − Start Time` |
| 8 | Approximate energy (duration × rate) vs recorded energy must agree within 20% | `energy_mismatch_gt_20pct` | Energy = Power × Time should roughly hold |
| 9 | Energy consumed must not exceed battery capacity | `energy_exceeds_capacity` | Can't charge more than the battery can hold |

**Why we flag instead of fix or delete:** The implementation plan explicitly says "Flag inconsistencies instead of silently fixing them." This keeps the dataset complete and lets downstream consumers decide how to handle flagged rows.

**Validation results:**

| Flag | Rows Affected | % of Dataset |
|---|---|---|
| `energy_mismatch_gt_20pct` | 1,045 | 79.2% |
| `duration_mismatch_gt_20pct` | 999 | 75.7% |
| `start_soc_gte_end_soc` | 268 | 20.3% |
| `energy_exceeds_capacity` | 190 | 14.4% |
| `end_soc_gt_100` | 23 | 1.7% |

**Total rows with at least one flag: 1,269 out of 1,320 (96.1%)**

> This is a very important finding. It tells us the dataset is synthetically generated with loosely coupled columns — the numeric fields were randomly generated independently rather than being derived from physical relationships. This doesn't make it useless for ML training (the patterns are still learnable), but it means we should not treat predictions as physically accurate.

### 3.4 Feature Engineering (`derive_features` function)

We derived 7 new columns from existing data:

| New Column | Formula / Logic | Why It's Useful |
|---|---|---|
| `socDelta` | End SOC − Start SOC | Direct measure of how much charge was added |
| `requiredEnergyApprox` | (socDelta / 100) × Battery Capacity | Rough energy needed based on SOC change |
| `startHour` | Hour from Charging Start Time (0–23) | Time-of-day feature for ML models |
| `isWeekend` | 1 if Saturday/Sunday, else 0 | Weekend vs weekday pattern |
| `startMonth` | Month from Charging Start Time (1–12) | Seasonal patterns |
| `computedDurationHours` | (End Time − Start Time) in hours | Ground truth duration from timestamps |
| `dataQualityFlag` | Pipe-separated validation flags | Quality tracking for each row |

We also stripped whitespace from `Vehicle Model`, `Charger Type`, and `User Type` to normalize category strings.

### 3.5 Imputation

For the 3 columns with 66 nulls each, we used **vehicle-model group median** imputation:

```python
df[col] = df.groupby("Vehicle Model")[col].transform(lambda s: s.fillna(s.median()))
```

**Why group median?** The implementation plan says "Impute only defensible missing values (for example median numeric value within vehicle/charger group)." Group median is more defensible than global median because different vehicle models have different typical energy consumption and charging rates.

If an entire vehicle-model group had all nulls (didn't happen here), we fall back to the global median as a safety net.

| Column Imputed | Nulls Filled | Method |
|---|---|---|
| Charging Rate (kW) | 66 | Median within Vehicle Model group |
| Energy Consumed (kWh) | 66 | Median within Vehicle Model group |
| Distance Driven (since last charge) (km) | 66 | Median within Vehicle Model group |

### 3.6 Output

The pipeline produces two files:

1. **`charging_clean.parquet`** — 1,320 rows × 27 columns (20 original + 7 derived), zero nulls, with Parquet format for efficient storage and type preservation.

2. **`cleaning_summary.json`** — Machine-readable report containing:
   - Timestamp of when cleaning ran
   - Source and output file paths
   - Row counts (before, after, excluded)
   - Flag breakdown with counts
   - Imputation details
   - Full raw data profile (ranges, dtypes, uniques)
   - List of derived features
   - Important notes/caveats

### 3.7 How to run

```bash
cd laptop-2
source .venv/bin/activate

# Default paths (reads ../Data/ev_charging_patterns.csv, writes data/processed/charging_clean.parquet)
python src/prepare_charging_data.py

# Custom paths
python src/prepare_charging_data.py --src /path/to/csv --out /path/to/output.parquet
```

---

## 4. The EDA Report — `01_data_quality_eda`

We created the EDA analysis in two formats:
- **`notebooks/01_data_quality_eda.py`** — standalone Python script that generates all plots headlessly (uses `matplotlib.use("Agg")`) and prints the report to terminal. This is the reproducible version.
- **`notebooks/01_data_quality_eda.ipynb`** — Jupyter notebook version with the same analysis in interactive cell format.

### 4.1 The 8 plots generated

All plots are saved as PNG files at 150 DPI in `data/processed/plots/`:

| # | Plot | File | What It Shows |
|---|---|---|---|
| 1 | Missingness Heatmap | `01_missingness.png` | Which columns have nulls and where — shows 3 columns (Energy, Rate, Distance) each with 66 missing values |
| 2 | Duration & Energy Distributions | `02_duration_energy_dist.png` | Histograms with median lines — duration roughly uniform 0–8 hours, energy roughly uniform 0–150 kWh |
| 3 | Energy by Vehicle Model & Charger Type | `03_energy_by_model_charger.png` | Box plots — similar distributions across all 5 models and 3 charger types (consistent with synthetic data) |
| 4 | Charging Rate vs Temperature | `04_rate_vs_temperature.png` | Scatter plot coloured by duration — no clear temperature effect visible |
| 5 | SOC Delta vs Energy | `05_soc_delta_vs_energy.png` | Scatter with negative-delta rows marked as black X — 268 rows where SOC decreased during "charging" |
| 6 | Time-of-Day Demand | `06_time_of_day_demand.png` | Bar charts by hour (0–23) and by time-of-day category — roughly even distribution |
| 7 | Data Quality Flags | `07_data_quality_flags.png` | Horizontal bar chart of flag counts — energy mismatch is the most common (1,045 rows) |
| 8 | Correlation Matrix | `08_correlation_matrix.png` | Heatmap of numeric feature correlations — weak correlations overall, confirming independently generated synthetic columns |

### 4.2 How to run

```bash
cd laptop-2
source .venv/bin/activate

# Script version (headless, saves PNGs)
python notebooks/01_data_quality_eda.py

# Notebook version (interactive)
jupyter notebook notebooks/01_data_quality_eda.ipynb
```

---

## 5. The Data Dictionary

**File:** `laptop-2/data/processed/data_dictionary.md`

A comprehensive reference document containing:
- Description of all 20 original columns with types, units, ranges, and null counts
- Description of all 7 derived columns with formulas
- Data quality flag definitions and counts
- Imputation methods used
- Key observations about the dataset's synthetic nature

---

## 6. Key Findings & Important Caveats

### 6.1 The dataset is synthetic

96.1% of rows fail at least one physical consistency check. The columns were generated independently rather than from physically coherent simulations. This is fine for a learning/demo project but must be clearly communicated.

### 6.2 No longitudinal battery data

Each User ID appears exactly once. There are no repeated measurements for the same battery over time. This means:
- ❌ Cannot build real battery degradation models from this CSV alone
- ❌ Cannot calculate true SOH decline over cycles
- ❌ Cannot estimate real RUL (remaining useful life)
- ✅ Can train session-level predictions (duration, energy) using this data
- ✅ Battery SOH/RUL will need a separate aging dataset (Phase 3 of the plan)

### 6.3 Temperature is ambient, not battery cell

The `Temperature (°C)` column ranges from −10.7 to 73.2°C. This represents ambient/environmental temperature, NOT battery cell temperature. The Arduino sensor in later phases will also measure ambient temperature. Never label it as "battery temperature" in the UI.

### 6.4 No rows were deleted

All 1,320 rows are preserved in the cleaned output. Instead of deleting problematic rows, we added the `dataQualityFlag` column so downstream code can filter or weight rows based on their quality issues.

---

## 7. Final Output Summary

| Item | Details |
|---|---|
| Input | `Data/ev_charging_patterns.csv` — 1,320 rows × 20 columns |
| Output | `laptop-2/data/processed/charging_clean.parquet` — 1,320 rows × 27 columns |
| Nulls before | 198 (66 per column × 3 columns) |
| Nulls after | 0 (all imputed with vehicle-model group median) |
| Rows excluded | 0 |
| Rows flagged | 1,269 (96.1%) |
| New features | 7 derived columns |
| Plots | 8 PNG files |
| Reports | cleaning_summary.json + data_dictionary.md |

---

## 8. Files Created in This Phase

```
laptop-2/src/prepare_charging_data.py           # Cleaning pipeline script
laptop-2/notebooks/01_data_quality_eda.py        # EDA script (generates plots)
laptop-2/notebooks/01_data_quality_eda.ipynb     # EDA Jupyter notebook
laptop-2/data/processed/charging_clean.parquet   # Cleaned dataset
laptop-2/data/processed/cleaning_summary.json    # Machine-readable cleaning report
laptop-2/data/processed/data_dictionary.md       # Human-readable column reference
laptop-2/data/processed/plots/01_missingness.png
laptop-2/data/processed/plots/02_duration_energy_dist.png
laptop-2/data/processed/plots/03_energy_by_model_charger.png
laptop-2/data/processed/plots/04_rate_vs_temperature.png
laptop-2/data/processed/plots/05_soc_delta_vs_energy.png
laptop-2/data/processed/plots/06_time_of_day_demand.png
laptop-2/data/processed/plots/07_data_quality_flags.png
laptop-2/data/processed/plots/08_correlation_matrix.png
```

---

## 9. What's Next — Phase 2

Phase 2 will use the cleaned Parquet file from this phase to train two regression models:
1. **Charging Duration prediction** (target: hours)
2. **Energy Consumed prediction** (target: kWh)

The derived features (socDelta, startHour, isWeekend, etc.) and the dataQualityFlag column will be directly useful for feature selection and data filtering in model training.
