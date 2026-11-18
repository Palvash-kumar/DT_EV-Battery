# Battery Model Limitations

> **Read this before using SOH, RUL or battery-wear numbers in a dashboard, report or presentation.**

## 1. Data

The battery models are trained on **measured lab data** (details and licences in
`laptop-2/data/battery_aging/data_card.md`):

| Dataset | Cells | What varies | Used for |
|---|---|---|---|
| ISU-ILCC (2023, CC BY 4.0) | 251 NMC/graphite pouch cells, 250 mAh, 30 °C | charge 0.5-3C, discharge 0.5-2.5C, depth of discharge 4-98 % (63 conditions) | cycle life, RUL, battery wear per session |
| NASA PCoE (2007, public domain) | 34 LiCoO2 18650 cells, 2 Ah (15 used) | temperature 24/43 °C, discharge current | SOH from the charging curve |

An earlier version of this project used **synthetic** aging curves (wrongly described as NASA data). They
have been removed.

### 1.1 Lab cells are not EV packs

| Lab test | Real EV |
|---|---|
| Constant temperature (30 °C or 24/43 °C) | −20 °C to +45 °C, with thermal management |
| Constant-current cycling, back to back | Driving, regenerative braking, long rests |
| Single small cell | Pack of hundreds to thousands of cells |
| No calendar aging | Most EV capacity loss comes from age, not cycles |
| Ages in hundreds of cycles | EV packs last thousands of cycles |

Because of the last row, **lab cycle counts are never copied to a car**. Only the *relative* effect of charge
rate and depth of discharge is transferred (see 2.3).

## 2. Models and how well they do

Every score below is on cells or test conditions the model never saw.

### 2.1 Cycle life (ISU-ILCC) — drives the wear factor
- Predicts equivalent full cycles (EFC) until capacity falls to 80 %, from charge rate, discharge rate and depth
  of discharge.
- Polynomial ridge regression: ~29 % average error on unseen test conditions (R² 0.56 in cross-validation).
- Cells tested under identical conditions differ by ~18 % from each other, so no model can do much better.
- Strongest effect: depth of discharge. Charge rate matters mainly above ~2C.

### 2.2 RUL (ISU-ILCC)
- Predicts remaining EFC to 80 % from the current state (EFC so far, capacity retention) and conditions.
- Gradient boosting: error ~115 EFC in cross-validation (R² 0.77), ~195 EFC on held-out conditions (R² 0.72).
- Early prediction (as in Severson et al. 2019): adding the change in the discharge voltage curve after the
  first 25 EFC cuts life-prediction error from 25 % to 21 %.

### 2.3 What the dashboard shows for a charging request
- **SOH**: fleet average from vehicle age (~1.8 %/year). Not a model of this car and not a BMS reading.
- **Wear factor**: life at a gentle reference charge (0.5C, 50 % depth) ÷ life at this session's charge rate and
  depth, from the cycle-life model. Faster charging is never treated as gentler than slower charging (in the
  lab data, 1-2C sometimes outlived 0.5C; that is treated as noise). Charge rates below 0.5C use 0.5C.
- **Battery wear %**: this session's EFC × 20 % ÷ (2000 EFC ÷ wear factor). The 2000-EFC pack life is an
  **assumption** (typical NMC EV cell rating), not learned from data.
- **RUL (cycles)**: remaining SOH above 80 % at that wear rate, assuming every future charge is like this one,
  and ignoring calendar aging.

### 2.4 SOH from the charging curve (NASA)
- Estimates SOH from the 3.9-4.2 V part of a standard CC-CV charge (charge in that window, time, CV time,
  temperature).
- Ridge regression: 2.8 percentage points average error, R² 0.84, testing each battery once while held out.
- Needs voltage data from a full CC-CV charge. The station does not stream charger voltage yet, so this model is
  trained and evaluated but not used for live requests.

## 3. What must NOT be claimed

1. ❌ "The model measures battery SOH" — SOH is estimated from vehicle age.
2. ❌ "The EV's battery has X% health" — without BMS data this is a fleet average.
3. ❌ "The battery will last N more cycles" — RUL is an estimate with large uncertainty.
4. ❌ "Temperature from Arduino is battery temperature" — it's ambient temperature.
5. ❌ "This model works for any EV battery" — trained on two lab chemistries.
6. ❌ "Fast charging costs exactly X % of battery life" — the wear factor is relative and approximate.

## 4. What CAN be claimed

1. ✅ "Battery wear factors come from a model trained on 251 lab cells under 63 charge/discharge conditions,
   scored on conditions it never saw."
2. ✅ "In that data, deep cycles and charging above ~2C shorten cycle life most."
3. ✅ "SOH can be estimated from a standard charging curve with ~3 percentage points error on unseen lab cells."
4. ✅ "RUL counts cycles until SOH falls below a configurable threshold (default 80 %)."
5. ✅ "Lab-to-field transfer needs calibration with real vehicle BMS data."

## 5. Future improvements

1. Stream charger voltage and current, so the NASA-style SOH model can run on every full charge.
2. Calibrate the 2000-EFC pack life and the 1.8 %/year fleet fade with real BMS or fleet data.
3. Add calendar aging (time and temperature at rest).
4. Add LFP and NCA cells (e.g. the Sandia dataset on batteryarchive.org) and use chemistry as an input.
5. Report prediction intervals, not just point estimates.
