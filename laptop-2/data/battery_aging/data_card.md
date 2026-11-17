# Battery Aging Data Card

## Source

**Primary:** NASA Prognostics Center of Excellence (PCoE) Battery Dataset
- **URL:** https://www.nasa.gov/content/prognostics-center-of-excellence-data-set-repository
- **License:** Public domain (US Government work, NASA Open Data)
- **Citation:** B. Saha and K. Goebel (2007). "Battery Data Set", NASA Prognostics Data Repository, NASA Ames Research Center, Moffett Field, CA

**Fallback:** If the NASA dataset cannot be downloaded, a synthetic dataset is generated using physics-based empirical degradation models (see `raw/generation_metadata.json`).

## Chemistry & Cell Specifications

| Property | Value |
|---|---|
| Cell Format | 18650 cylindrical |
| Chemistry | Lithium Cobalt Oxide (LiCoO₂) cathode |
| Nominal Capacity | 2.0 Ah |
| Nominal Voltage | 3.7 V |
| Charge Protocol | Constant Current (CC) at 1.5 A until 4.2 V, then Constant Voltage (CV) until 20 mA cutoff |
| Discharge Protocol | CC at various currents (1–4 A) until 2.7 V cutoff |
| Test Temperatures | 4°C, 24°C, 43°C (ambient chamber temperature) |

## Test Protocol

Batteries were repeatedly charged and discharged under controlled laboratory conditions:

1. **Charge phase:** CC-CV charging at 1.5 A / 4.2 V
2. **Discharge phase:** Constant current discharge at specified rate until 2.7 V cutoff
3. **Measurement:** Discharge capacity (Ah) recorded per cycle
4. **Impedance:** Electrochemical Impedance Spectroscopy (EIS) performed periodically

## Batteries Used

| Battery ID | Temperature (°C) | Discharge Rate | Approx. Cycles |
|---|---|---|---|
| B0005 | 24 | 2.0 A | ~616 |
| B0006 | 24 | 2.0 A | ~616 |
| B0007 | 24 | 2.0 A | ~616 |
| B0018 | 24 | 2.0 A | ~530 |
| B0025 | 43 | 1.0 A | ~474 |
| B0026 | 43 | 1.0 A | ~474 |
| B0033 | 4 | 2.0 A | ~580 |
| B0034 | 4 | 2.0 A | ~580 |

## Important Limitations

### Chemistry Limitation
The cells are small-format 18650 LiCoO₂ cells. Modern EV batteries use different chemistries:
- **NMC (Nickel Manganese Cobalt)** — most common in EVs
- **LFP (Lithium Iron Phosphate)** — used in some EVs (e.g., Tesla SR+)
- **NCA (Nickel Cobalt Aluminum)** — used in Tesla vehicles

Degradation behavior differs significantly across chemistries.

### Lab vs Real-World
- **Lab conditions:** Controlled temperature, constant charge/discharge protocols
- **Real EV conditions:** Variable temperature, mixed driving patterns, calendar aging, partial charges, regenerative braking, fast charging stress
- **Transfer gap:** Lab results do NOT directly predict real EV battery health without calibration

### Scale Limitation
- **Lab cells:** 2 Ah, single cell
- **EV battery packs:** 50–100 kWh, thousands of cells with pack-level thermal management
- Pack behavior includes cell-to-cell variation, BMS balancing, and thermal gradients

### What This Data CAN and CANNOT Support

| ✅ Can Support | ❌ Cannot Support |
|---|---|
| Demonstrating SOH/RUL methodology | Certifying real EV battery health |
| Training capacity-fade prediction models | Predicting specific EV model lifetime |
| Understanding degradation trends | Replacing a Battery Management System |
| Academic project demonstrations | Making warranty/safety decisions |

## EOL Threshold

The end-of-life (EOL) threshold is set at **80% SOH** (capacity retention). This is a common industry convention but is **configurable** — different applications use 70–85%.

## Data Processing

1. Raw .mat files extracted and discharge capacity per cycle recorded
2. SOH calculated: `SOH = currentCapacity / nominalCapacity × 100`
3. RUL calculated: cycles remaining until SOH ≤ 80% (extrapolated if battery hasn't reached EOL yet)
4. All data saved as normalized Parquet file for model training
