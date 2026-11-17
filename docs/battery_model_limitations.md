# Battery Model Limitations

> **This document must be read and understood before using SOH/RUL predictions in any downstream application, dashboard, or report.**

## 1. Data Limitations

### 1.1 Synthetic Dataset (Current Implementation)

The battery aging data used in this project is **synthetically generated** using physics-based empirical degradation models. It was not measured from real battery cells.

**Why synthetic?** The NASA PCoE Battery Dataset (the intended real source) is a 200 MB download in MATLAB format. For this college-project demonstration, we generate realistic degradation curves based on published Li-ion capacity fade models:
- Power-law capacity fade: Q(n) = Q₀ × (1 - α × n^β)
- Arrhenius temperature acceleration factor
- Knee-point degradation acceleration below ~78% SOH

The synthetic data produces degradation curves that look realistic but are NOT measured data.

### 1.2 Single Chemistry

The data models Li-ion 18650 cells (LiCoO₂ cathode). Real EV batteries use:
- **NMC** (Nickel Manganese Cobalt) — most common
- **LFP** (Lithium Iron Phosphate) — Tesla Standard Range+, BYD
- **NCA** (Nickel Cobalt Aluminum) — Tesla Long Range

Each chemistry has fundamentally different degradation characteristics.

### 1.3 Lab vs. Real-World Conditions

| Lab Environment | Real EV Environment |
|---|---|
| Constant temperature chamber | Variable weather, −20°C to +45°C |
| Fixed charge/discharge protocol | Regenerative braking, variable power |
| 100% DoD cycling | Partial charges (20–80% common) |
| Single cell | Pack of thousands of cells |
| No calendar aging | Months of storage between drives |

## 2. Model Limitations

### 2.1 SOH Model
- Predicts SOH as a function of cycle count and operating conditions
- Cannot account for manufacturing defects, cell-to-cell variation, or pack-level effects
- Assumes monotonic degradation — cannot model recovery effects or knee-point timing accurately
- **Dashboard label:** "Model estimate from aging-data domain" — NOT "Measured EV SOH"

### 2.2 RUL Model
- Predicts remaining cycles to 80% SOH threshold
- The 80% threshold is a **configurable assumption**, not a physical law
- Early-life RUL predictions have high uncertainty (small changes in degradation rate compound over hundreds of cycles)
- Cannot predict sudden capacity drops (e.g., internal short, dendrite growth)
- **Dashboard label:** "Estimated RUL (model, lab conditions)" — NOT "Guaranteed battery lifetime"

## 3. What Must NOT Be Claimed

1. ❌ "The model measures battery SOH" — it **estimates** SOH from an aging-data model
2. ❌ "The EV's battery has X% health" — without real BMS data, this is an estimate from lab data
3. ❌ "The battery will last N more cycles" — RUL is an estimate with significant uncertainty
4. ❌ "Temperature from Arduino is battery temperature" — it's ambient temperature
5. ❌ "This model works for any EV battery" — trained on one chemistry, one form factor

## 4. What CAN Be Claimed

1. ✅ "The model estimates SOH based on cycle count and operating conditions from lab aging data"
2. ✅ "RUL is estimated as the number of cycles until SOH drops below a configurable threshold (default: 80%)"
3. ✅ "The pipeline demonstrates SOH/RUL methodology that could be applied to real battery data"
4. ✅ "Lab-to-field transfer requires calibration with real vehicle BMS data"

## 5. Future Improvements

To move from demonstration to production:
1. Obtain real EV battery aging data from BMS logs or fleet telemetry
2. Use chemistry-matched degradation models
3. Incorporate calendar aging (time-based degradation, not just cycle-based)
4. Add uncertainty quantification (prediction intervals, not just point estimates)
5. Validate against real vehicle battery health assessments
