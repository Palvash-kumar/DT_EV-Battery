# Phase 10 — Real datasets and retrained models

Goal of this phase: replace the models trained on the synthetic `ev_charging_patterns.csv` and the synthetic
battery aging curves with models trained on **real, public datasets**, check every model honestly, and add
charging cost and battery wear to the predictions.

---

## 1. Why the old models gave "nearly the same time for everything"

`Data/ev_charging_patterns.csv` (1,320 rows) is synthetic and its target columns are random:

- every correlation between duration, energy or cost and any input is between −0.06 and +0.06
- Level 1 and DC fast chargers have the same average rate (about 26 kW) and duration (about 2.3 h)
- the duration column does not match the start and end timestamps; 268 rows charge from a higher SOC to a lower one
- 136 pairwise tests found 7 "significant" results at p < 0.05, the number expected by chance; none survive correction

`src/study_ev_charging_patterns.py` repeats the training properly (cleaning, 95/5 split, 5-fold CV) and runs a
permutation test (retraining on shuffled labels). Shuffled labels score the same as real ones, so a correct model
can only predict the average. Results: `laptop-2/models/ev_charging_patterns_study.json`.

The old battery data (`aging_normalized.parquet`) was also synthetic, though its data card called it NASA data:
it had 616 "cycles" per battery (NASA's count of *all* operations for B0005; there are 168 discharges) and wrong
temperatures. It has been removed.

---

## 2. Datasets

| Dataset | Size | Licence | Used for |
|---|---|---|---|
| City of Palo Alto EV charging, 2011-2020 | 259,415 sessions, 47 stations | City open data | Level 1/2 charging time, cost |
| Caltech ACN-Data (Caltech, JPL, office) | 66,745 sessions | registration (token) | external test of charging time |
| ISU-ILCC battery aging | 251 cells, 63 conditions | CC BY 4.0 | cycle life, RUL, battery wear |
| NASA PCoE battery | 34 cells | public domain | SOH from the charging curve |

Download everything with `python src/download_datasets.py nasa isu isu-raw paloalto acn` (about 10.5 GB; the
ISU cycling archive is read zipped because it unpacks to 66 GB). Details: `laptop-2/data/battery_aging/data_card.md`.

---

## 3. Pipeline

```
laptop-2/src/
├── download_datasets.py           # fetch all datasets
├── study_ev_charging_patterns.py  # proof that the synthetic CSV has no signal
├── prepare_sessions.py            # Palo Alto + ACN -> one clean session table
├── train_session_models.py        # charging time, cost, idle time
├── prepare_isu.py                 # ISU cells -> capacity per check + exact cycle counts
├── train_battery_degradation.py   # cycle life, RUL, early life prediction
├── prepare_nasa.py                # NASA cells -> charge-curve features per cycle
└── train_battery_soh.py           # SOH from the charging curve
laptop-2/ml_service/
├── charging_physics.py            # physics estimator (energy; DC fast duration and cost)
├── model_wrappers.py              # physics × correction and tariff + residual estimators
├── battery_health.py              # wear factor, wear %, RUL for a request
└── predictors.py                  # combines everything for one request
```

Rules used everywhere:
- **95/5 split by group**, never by random rows: by driver for sessions, by battery for NASA, by test
  condition for ISU. Rows from one driver or cell are never in both train and test.
- **Model chosen by cross-validation on the 95 %**, not by the 5 % test set (the old scripts chose by test score).
- Every model is compared with a "predict the average" baseline and, where one exists, a formula baseline.

---

## 4. Results

### 4.1 Charging sessions (scored on drivers never seen in training)

| Model | Selected | Test error | Test R² | Baselines |
|---|---|---|---|---|
| Charging time (Level 1/2) | physics time × learned correction (gradient boosting) | 0.183 h (11 min) | 0.918 | formula 0.201 h / R² 0.888; average 0.948 h |
| Cost (Level 1/2) | learned $/kWh + learned extra fees (gradient boosting) | $0.20 (CV $0.13) | 0.69 (CV 0.82) | flat $0.23/kWh: $0.23 / R² 0.59 |
| Idle time after charging | gradient boosting | 0.51 h | 0.15 | not used for predictions (human behaviour) |

- The car's charging power is a model input. In the data it is estimated from each driver's *other* sessions
  (90th percentile of average power, leave-one-out); at prediction time it is the vehicle's on-board charger limit.
- The cost model learned **$0.2301/kWh** from the fees alone; Palo Alto's published rate is $0.23/kWh. Long
  plug-in times add fees ($0.75 median for 2-4 h, $8.53 for 8-24 h).
- External test on 44,724 ACN-Data sessions from other sites: error 0.97 h, R² 0.44 (formula: 1.03 h, R² 0.39).
  ACN uses smart charging that slows cars to share power, so charging time there depends on the scheduler.

### 4.2 Battery

| Model | Selected | Score on unseen cells/conditions |
|---|---|---|
| SOH from charging curve (NASA) | Ridge | 2.8 percentage points, R² 0.84 (each battery held out once) |
| Cycle life (ISU) | polynomial ridge | ~29 % error (cell-to-cell spread alone is 18 %) |
| RUL (ISU) | gradient boosting | 115 EFC, R² 0.77 (CV); 195 EFC, R² 0.72 (held-out conditions) |
| Early life prediction (ISU) | Gaussian process | 25.3 % → 20.7 % error when the voltage curve after 25 EFC is added |

Depth of discharge has the strongest effect on cycle life; charge rate matters mainly above about 2C.

---

## 5. What each prediction now uses

| Output | Level 1 / Level 2 | DC fast |
|---|---|---|
| Duration | trained model (Palo Alto) | physics (no public DC session data) |
| Energy | physics: SOC window × usable capacity ÷ efficiency | same |
| Cost | trained model (Palo Alto fees) | energy × `PRICE_DCFC_USD_PER_KWH` (default $0.48) |
| SOH | fleet average from vehicle age (1.8 %/year) | same |
| Wear factor, wear %, RUL | cycle-life model (ISU), relative to a gentle charge | same |

Each result records which model produced it (`durationVersion` etc.), and the dashboard shows
"ML estimate" or "Physics estimate" accordingly. The worker now also publishes an SOH/RUL estimate on
`evdt/v1/results/health` for every request, which fills the Battery Health page.

Example outputs (2026-11-18, 18:00):

| Request | Time | Energy | Cost | Wear factor |
|---|---|---|---|---|
| Tesla Model 3, 20→80 %, DC 250 kW | 20 min | 45.8 kWh | $21.97 | 1.10 |
| Tesla Model 3, 20→80 %, Level 2 11.5 kW | 4 h 40 min | 47.3 kWh | $10.88 | 1.10 |
| Nissan Leaf, 20→80 %, Level 1 | 16 h 10 min | 25.7 kWh | $5.91 | 1.10 |
| Chevy Bolt, 10→90 %, Level 2, −5 °C | 9 h 58 min | 62.8 kWh | $14.45 | 1.34 |
| BMW i3, 10→100 %, DC 50 kW | 1 h 5 min | 39.9 kWh | $19.16 | 1.47 |

---

## 6. Contract and dashboard changes

- `charging-result.schema.json`: new optional `costUsd`, `estimatedSohPct`, `batteryWearPct`, `wearFactor`,
  and `model.costVersion`, `model.wearVersion`.
- Backend stores the new fields and labels results `ml_estimate`, `physics_estimate` or `simulation`.
- Request page: cost and battery-wear tiles; model cards show the real-data scores. History table: cost column.
- Battery Health page: describes the real datasets and the scores on unseen cells.

## 7. Tests

- Python worker: 28 tests, including behaviour checks (bigger SOC window → longer and costlier, DC faster than
  Level 2 faster than Level 1, cold → slower, older car → lower SOH and RUL, deep or very fast charges → more wear,
  results valid against both shared schemas).
- Backend: 53 tests. Frontend: 27 tests, and the production build passes.

## 8. Running it

```bash
cd laptop-2
pip install -r requirements.txt     # pinned: models must load with the scikit-learn that trained them
python ml_service/main.py
```

The three models the worker loads (`session_duration`, `session_cost`, `battery_life`, about 4 MB) are tracked in
git. To retrain from scratch, see `docs/connection.md` §2.3.

## 9. Limitations

See `docs/battery_model_limitations.md`. In short: no public DC session data, so DC uses physics; Palo Alto is
an unmanaged 2011-2020 fleet with chargers up to ~7 kW; battery data comes from lab cells, so only relative wear
effects are transferred, and the 2000-cycle pack life is an assumption.
