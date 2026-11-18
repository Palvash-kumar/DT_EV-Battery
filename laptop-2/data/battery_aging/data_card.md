# Data Card: datasets used for training

All raw files are downloaded by `python src/download_datasets.py nasa isu isu-raw paloalto acn`
and are not committed (see `.gitignore`).

## 1. NASA PCoE Battery Data Set (battery SOH)

- **Source:** NASA Prognostics Center of Excellence, <https://phm-datasets.s3.amazonaws.com/NASA/5.+Battery+Data+Set.zip>
- **Citation:** B. Saha and K. Goebel (2007). "Battery Data Set", NASA Prognostics Data Repository, NASA Ames Research Center.
- **License:** US Government work (public domain).
- **Cells:** 34 LiCoO2 18650 cells, rated 2.0 Ah. Charge 1.5 A CC to 4.2 V, then CV to 20 mA.
- **Conditions (from NASA's README files):**

| Batteries | Ambient | Discharge | Used for SOH model |
|---|---|---|---|
| B0005-07, B0018 | 24 °C | 2 A CC | yes |
| B0025-28 | 24 °C | 4 A square wave | yes |
| B0029-32 | 43 °C | 4 A CC | yes |
| B0033, B0034, B0036 | 24 °C | 4 A / 2 A CC | yes |
| B0038-40 | 24 & 44 °C | 1/2/4 A mixed | no (mixed loads) |
| B0041-56 | 4 °C | 1-4 A | no (NASA reports unexplained low-capacity runs) |

- **Processing:** `src/prepare_nasa.py`. One row per discharge cycle (2,483 after cleaning), paired with features
  of the charge before it (charge between 3.9 and 4.19 V, time for that rise, CV time, end temperature).
- **Earlier mistake:** the previous `aging_normalized.parquet` was *synthetic*, with 616 "cycles" per battery
  (616 is NASA's count of all operations for B0005, not discharge cycles: there are 168) and wrong
  temperatures for B0025/26/33/34. It has been removed.

## 2. ISU-ILCC Battery Aging Dataset (cycle life, RUL, wear)

- **Source:** Figshare, doi:10.25380/iastate.22582234 (Release 2.0).
- **Citation:** T. Li, J. Liu, A. Thelen, C. Tischer, C. Hu, "Predicting Battery Lifetime Under Varying Usage
  Conditions from Early Aging Data" (arXiv:2307.08382).
- **License:** CC BY 4.0.
- **Cells:** 251 NMC/graphite 502030 pouch cells, rated 250 mAh, cycled at 30 °C under 63 conditions:
  charge 0.5-3C, discharge 0.5-2.5C, depth of discharge 4-98 %. Capacity checked weekly at C/5.
- **Processing:** `src/prepare_isu.py`. Equivalent full cycles (EFC) at each capacity check come from the raw
  cycling files (cumulative discharged Ah / 0.25 Ah). Life = EFC at 80 % of the first measured capacity.

## 3. City of Palo Alto EV charging sessions (duration, cost)

- **Source:** City of Palo Alto open data, "Electric Vehicle Charging Station Usage (July 2011 - Dec 2020)".
- **Rows:** 259,415 sessions at 47 public Level 1/2 stations; 252,841 after cleaning (`src/prepare_sessions.py`).
- **Fee:** free until mid-2017, then $0.23/kWh plus charges for long plug-in times.
- **Privacy:** contains pseudonymous driver IDs and driver postal codes. Used only to group sessions by driver;
  never committed.

## 4. Caltech ACN-Data (external test)

- **Source:** <https://ev.caltech.edu/dataset> (Lee, Li, Low, "ACN-Data", ACM e-Energy 2019). Needs an API token;
  set `ACN_API_TOKEN` (the public demo token is used otherwise).
- **Sites:** Caltech, JPL and an office site. Level 2 with managed (shared) charging.
- **Use:** external test of the duration model on sites it was not trained on.

## 5. ev_charging_patterns.csv (not used for training)

Synthetic: duration, energy and cost are statistically independent of every input. See
`models/ev_charging_patterns_study.json` (`src/study_ev_charging_patterns.py`).

## What the data can and cannot support

| Can support | Cannot support |
|---|---|
| Real-world Level 1/2 charging time and fees | DC fast-charging sessions (no public data; physics used) |
| How charge rate and depth of discharge change cell cycle life | Absolute life of a specific EV pack |
| SOH from a standard CC-CV charging curve | SOH from a short or partial top-up charge |
| Methodology for a digital twin | Warranty, safety or BMS decisions |
