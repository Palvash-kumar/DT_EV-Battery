# EV Charging Station Digital Twin — Implementation Plan

## 1. Purpose and agreed architecture

Build a beginner-friendly, two-laptop digital twin for an EV charging station.

**Use MQTT with Mosquitto, not OPC UA, for the first version.** MQTT fits the required request/result flow, has excellent Node.js and Python support, and is much faster to demonstrate over a LAN/Wi-Fi network. OPC UA can be recorded as a future industrial integration option.

```text
Laptop 1: React + Three.js website -> Node.js/Express API -> MQTT client
                                                     |                 
                                                  LAN/Wi-Fi             
                                                     v                 
Laptop 2: Mosquitto broker <- Python inference / optimization service
                                                     |
                                           trained model files + datasets
```

Laptop 1 creates a validated prediction request. Laptop 2 receives it through Mosquitto, runs locally stored models, and publishes a correlated result. Laptop 1 stores and displays the result. **Models never travel over MQTT.**

### Reality labels (important)

| Item | Status in the first version |
|---|---|
| Historical charging sessions | Real records from `Data/ev_charging_patterns.csv` |
| Duration and energy predictions | ML estimates trained/evaluated from the CSV |
| Battery SOH, degradation, and RUL | Requires a separate battery-aging dataset; do not claim the charging CSV alone provides true battery degradation labels |
| Arduino temperature reading | Real only when read from the connected sensor; it represents ambient/charging-area temperature unless a safe approved BMS source is used |
| SOC, charger voltage/current/power, EV battery temperature | Simulated until a real meter/BMS connection is implemented; label each simulated value in the UI and database |
| 3D station | Visual digital-twin representation driven by real/simulated application state |

### Suggested repository structure

```text
DT_EV-Battery/
├── Data/ev_charging_patterns.csv
├── laptop-1/
│   ├── frontend/                 # React + Vite + React Three Fiber
│   └── backend/                  # Express, MQTT.js, Mongoose
├── laptop-2/
│   ├── data/battery_aging/       # separately licensed aging data
│   ├── notebooks/
│   ├── models/
│   ├── ml_service/               # Python MQTT inference worker
│   ├── tests/
│   └── mosquitto/mosquitto.conf
├── shared/
│   ├── schemas/                  # JSON Schemas and examples
│   └── docs/
├── docs/
└── Implementation_plan.md
```

## 2. Delivery order

Complete Phases 1–6 first. The first demonstrable milestone is: **submit a charging request on Laptop 1 → MQTT → predict on Laptop 2 → MQTT → display the correlated result on Laptop 1.** Add the 3D twin, sensor, optimization, and maintenance functions after this loop is reliable.

---

## Phase 0 — Project setup, network, and conventions

**Objective:** Create a reproducible project and a stable two-laptop development environment.

**Prerequisites:** Both laptops on the same trusted LAN/Wi-Fi; Node.js LTS, Python 3.11+, Git, and MongoDB (local or Atlas) available.

**Tasks:**

1. Create the folders above and initialize Git. Keep secrets in `.env`, never in Git.
2. Give Laptop 2 a stable LAN IP or DHCP reservation, for example `192.168.1.50`.
3. Record `MQTT_HOST`, `MQTT_PORT`, MongoDB URI, API URL, station ID, and allowed CORS origin in separate `.env.example` files.
4. Agree on UTC ISO timestamps, metric units (kWh, kW, °C, km), camelCase JSON fields, and UUID request IDs.
5. Create a `docs/decisions.md` entry explaining why MQTT is selected and which signals are simulated.

**Suggested files:** `.gitignore`, `README.md`, `docs/architecture.md`, `laptop-1/backend/.env.example`, `laptop-2/ml_service/.env.example`.

**Acceptance criteria / deliverables:** A clean clone can start both projects; both laptops can ping each other; no passwords or tokens are committed.

**Common pitfalls:** Laptop sleep changing network availability; dynamic IP addresses; using localhost for a service that must be reached from the other laptop; inconsistent timezone parsing.

**Copy-paste prompt:**

> You are a senior full-stack IoT engineer. Set up a monorepo for an EV Charging Station Digital Twin with `laptop-1/frontend` (React/Vite), `laptop-1/backend` (Node/Express), `laptop-2/ml_service` (Python), `laptop-2/models`, `shared/schemas`, and `docs`. Add safe `.env.example` files, `.gitignore`, an architecture README, and setup commands for macOS/Windows. Use MQTT broker host variables rather than localhost. Do not include secrets. Mark simulated telemetry explicitly.

---

## Phase 1 — Inspect, clean, and explore the charging dataset

**Objective:** Produce a trusted analytical dataset from the 1,320-row, 20-column source at `Data/ev_charging_patterns.csv`.

**Prerequisites:** Python virtual environment and the original CSV kept unchanged.

**Tasks:**

1. Create `laptop-2/notebooks/01_data_quality_eda.ipynb` and `laptop-2/src/prepare_charging_data.py`.
2. Load the CSV with explicit parsing for `Charging Start Time` and `Charging End Time`; profile nulls, duplicates, types, ranges, categories, and units.
3. Validate domain rules: battery capacity > 0; 0 ≤ starting SOC < ending SOC ≤ 100; energy/duration/rate/cost ≥ 0; end time after start time.
4. Compare recorded duration with `end - start`, and compare approximate energy (`duration × rate`) with recorded energy. Flag inconsistencies instead of silently fixing them.
5. Impute only defensible missing values (for example median numeric value within vehicle/charger group), or exclude rows with a documented reason. Add `dataQualityFlag` rather than hiding anomalies.
6. Derive features: `socDelta`, `requiredEnergyApprox`, hour, weekend flag, and normalized categories. Keep a data dictionary and a cleaning report.
7. Create EDA plots: missingness, duration/energy distributions, energy by vehicle model and charger type, rate vs temperature, SOC delta vs energy, and time-of-day demand.
8. Save `laptop-2/data/processed/charging_clean.parquet` and a versioned cleaning summary. Never overwrite the source CSV.

**Code guidance:**

```bash
cd laptop-2
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\\Scripts\\activate
pip install pandas numpy matplotlib seaborn jupyter pyarrow
```

**Acceptance criteria / deliverables:** Data dictionary; reproducible script/notebook; cleaned dataset; EDA report; documented row count before/after and all exclusions.

**Common pitfalls:** Treating synthetic-looking data as physical truth; data leakage by cleaning with test-set statistics; assuming one row represents longitudinal history for a specific battery. The dataset has one row per user/session rather than repeated battery-capacity measurements.

**Copy-paste prompt:**

> Analyze `Data/ev_charging_patterns.csv` for an EV charging digital-twin project. It has 1,320 rows and 20 columns. Write a reproducible Python cleaning script and EDA notebook. Preserve the source file, parse timestamps, validate physical ranges and internal consistency, document missing values and outliers, derive useful features, and save a cleaned Parquet file. Include charts and a data-quality report. Do not claim the data supports per-battery degradation labels.

---

## Phase 2 — Train charging-duration and energy models

**Objective:** Train two honest baseline prediction models: charging duration (hours) and energy consumed (kWh).

**Prerequisites:** Phase 1 cleaned data; agreed definition of the prediction moment. A prediction must use only fields known before/during the session, not target leakage.

**Tasks:**

1. Define targets exactly: `Charging Duration (hours)` and `Energy Consumed (kWh)`.
2. Choose valid input features. For pre-session estimates use vehicle model, battery capacity, starting/target SOC, charger type/rate, temperature, vehicle age, time/day, and location. Do **not** use end time or the recorded target value as an input.
3. Build a scikit-learn `ColumnTransformer`: median imputation for numeric fields, most-frequent/`Unknown` for categories, one-hot encoding for categorical fields.
4. Split train/test before fitting preprocessing. Prefer a time-aware split if timestamps make this practical; otherwise use a seeded split and explain the limitation.
5. Compare a simple baseline (median or linear regression) with Random Forest / HistGradientBoosting. Use cross-validation on training data.
6. Measure MAE, RMSE, R², residual plots, and errors by charger type/vehicle model. Select the simplest model that performs acceptably.
7. Save one pipeline per task with `joblib`, along with `model_metadata.json` containing features, target units, training date, metrics, dataset version, and limitations.

**Suggested files:** `laptop-2/src/train_duration.py`, `train_energy.py`, `evaluate_models.py`, `models/charging_duration.joblib`, `models/energy.joblib`.

**Acceptance criteria / deliverables:** Re-runnable training scripts; two serialized pipelines; held-out metrics report; input feature contract; sample inference command.

**Common pitfalls:** Leakage from energy/duration-related columns; confusing estimated energy with actual battery capacity; reporting only R²; training a model on tiny categories without validation.

**Copy-paste prompt:**

> Create two scikit-learn regression pipelines using the cleaned EV charging dataset: one predicts charging duration in hours and one predicts energy consumed in kWh. Prevent target leakage, use a fitted preprocessing pipeline, compare baseline and tree-based models, report MAE/RMSE/R² and subgroup errors, then save the selected pipelines with metadata. Provide CLI commands and unit tests for feature validation. Keep the results clearly labelled as estimates from this dataset.

---

## Phase 3 — Battery SOH, degradation, and RUL with a separate aging dataset

**Objective:** Add a scientifically honest battery-health module based on longitudinal capacity/cycle data.

**Prerequisites:** Obtain a license-compatible NASA, CALCE, or equivalent battery-aging dataset containing repeated cycles/capacity (and preferably current, voltage, temperature). Read its license and document chemistry/test conditions.

**Tasks:**

1. Store raw aging data under `laptop-2/data/battery_aging/raw/`; document source, chemistry, nominal capacity, test protocol, and license in `data_card.md`.
2. Normalize cycles so each battery has an ID, cycle count, capacity, temperature, C-rate, depth-of-discharge, and timestamp/sequence where available.
3. Calculate measured SOH: `SOH = currentCapacity / initialCapacity × 100`. Define the RUL end-of-life threshold (commonly 80% SOH) as a configurable assumption.
4. Split by battery ID, never random rows, to avoid showing the same battery's future cycles to the model during training.
5. Start with transparent baselines: per-battery capacity curve and regression on cycle number/conditions. Add Random Forest/XGBoost only after baseline evaluation; use sequence models only if data supports them.
6. Output estimated SOH, capacity loss, and `cyclesToEol`/RUL with uncertainty and applicability notes. Do not transfer lab-dataset results as a measured SOH for a real EV without calibration/validation.
7. Integrate session context from the charging CSV only as contextual/simulated risk features unless compatible, repeated real battery history exists.

**Suggested files:** `notebooks/03_battery_aging.ipynb`, `src/train_soh.py`, `src/train_rul.py`, `models/soh.joblib`, `docs/battery_model_limitations.md`.

**Acceptance criteria / deliverables:** Data card; SOH/RUL training/evaluation report split by battery; saved model; clear dashboard wording such as “model estimate from aging-data domain”, not “measured EV SOH.”

**Common pitfalls:** Using the 1,320-row charging CSV alone to claim true degradation; mixing cell chemistry/protocols; random row splits; treating ambient Arduino temperature as cell temperature.

**Copy-paste prompt:**

> Build a battery SOH/degradation/RUL module using a separate longitudinal battery-aging dataset, not the EV charging CSV alone. Create a data card, calculate SOH from measured capacity, split by battery ID, train transparent baselines before more complex models, and estimate RUL to a configurable 80% SOH threshold. Save model artifacts and state all chemistry/domain limitations. Design the API so the UI distinguishes estimated health from directly measured health.

---

## Phase 4 — Mosquitto MQTT broker and message contract

**Objective:** Establish secure, traceable two-laptop communication.

**Prerequisites:** Laptop 2 static IP; both laptops able to reach it; a trusted private network.

**Topics and QoS:**

| Topic | Publisher → subscriber | QoS | Retain | Purpose |
|---|---|---:|---:|---|
| `evdt/v1/requests/charging` | Laptop 1 → Laptop 2 | 1 | no | duration/energy request |
| `evdt/v1/results/charging` | Laptop 2 → Laptop 1 | 1 | no | correlated prediction result |
| `evdt/v1/telemetry/temperature` | Arduino gateway → both | 1 | no | sensor reading |
| `evdt/v1/results/health` | Laptop 2 → Laptop 1 | 1 | no | estimated SOH/RUL |
| `evdt/v1/results/optimization` | Laptop 2 → Laptop 1 | 1 | no | smart-charging plan |
| `evdt/v1/alerts` | services → Laptop 1 | 1 | no | anomalies/maintenance |
| `evdt/v1/stations/{stationId}/status` | backend → clients | 1 | yes | latest station state |

Use QoS 1 for business-critical messages because it offers at-least-once delivery. Therefore all consumers must be idempotent: deduplicate by `messageId`/`requestId`. Use retained messages only for current state, never one-time requests/results.

**Minimum request schema:**

```json
{
  "schemaVersion": "1.0",
  "messageId": "uuid",
  "requestId": "uuid",
  "sentAt": "2026-11-16T10:15:30.000Z",
  "stationId": "STATION-001",
  "vehicle": {"model": "Tesla Model 3", "batteryCapacityKwh": 75, "vehicleAgeYears": 3},
  "charging": {"startSocPct": 25, "targetSocPct": 80, "chargerType": "DC Fast Charger", "requestedRateKw": 50},
  "environment": {"temperatureC": 30, "source": "simulated"}
}
```

**Minimum result schema:**

```json
{
  "schemaVersion": "1.0",
  "messageId": "uuid",
  "requestId": "uuid",
  "status": "completed",
  "processedAt": "2026-11-16T10:15:31.000Z",
  "predictions": {"durationHours": 1.42, "energyKwh": 41.7},
  "model": {"durationVersion": "2026-11-16", "energyVersion": "2026-11-16"},
  "warnings": []
}
```

**Tasks:**

1. Install Mosquitto on Laptop 2 and use port 1883 only for a trusted prototype; test with `mosquitto_sub` and `mosquitto_pub`.
2. Add a password file, ACL file, non-anonymous users, and firewall rule restricted to the LAN. For any untrusted network, enable TLS on 8883 with certificates and never expose the broker directly to the internet.
3. Write JSON Schema files in `shared/schemas/` and validate payloads on both sides.
4. Set a backend request timeout (for example 15 seconds). On timeout, return `pending`/`timed_out`, persist the request, and allow a retry with a new `messageId` but the same logical `requestId` only when intentional.
5. Use MQTT client reconnect with exponential backoff, Last Will status, and structured logs. Do not block the broker callback with long ML work.

**Example commands:**

```bash
# Laptop 2: inspect broker traffic
mosquitto_sub -h 0.0.0.0 -t 'evdt/v1/#' -v
# Laptop 1: publish a test (replace host and credentials)
mosquitto_pub -h 192.168.1.50 -t evdt/v1/requests/charging -q 1 -m '{"requestId":"test"}'
```

**Acceptance criteria / deliverables:** Valid request/response exchanged over LAN, a matching `requestId`, timeout path demonstrated, authentication enabled, topic/schema documentation complete.

**Common pitfalls:** Broker bound only to `127.0.0.1`; anonymous public broker; duplicate QoS 1 messages; no timeout; frontend connecting directly to an insecure MQTT broker.

**Copy-paste prompt:**

> Configure Mosquitto on Laptop 2 for a private LAN EV Digital Twin. Create documented MQTT topics, QoS choices, JSON Schemas, password/ACL configuration, reconnect behavior, request IDs, message IDs, a 15-second timeout, and idempotent duplicate handling. Provide Mosquitto CLI test commands and do not expose the broker to the public internet. Use TLS guidance for any network beyond a trusted LAN.

---

## Phase 5 — Python inference worker on Laptop 2

**Objective:** Turn saved model pipelines into a robust MQTT request/response service.

**Prerequisites:** Models from Phase 2; valid schemas; broker running.

**Tasks:**

1. Create `laptop-2/ml_service/main.py`, `schemas.py`, `predictors.py`, `mqtt_client.py`, and `config.py`.
2. Load `joblib` pipelines once at startup; verify expected feature names and model metadata.
3. Subscribe to `evdt/v1/requests/charging`. Validate schema, units, and business rules before inference.
4. Use a worker queue/executor so an MQTT callback stays short. Run duration and energy predictions, reject invalid values, round only for display, and attach model version.
5. Publish success or structured error on the result topic with the original `requestId`. Errors must not leak stack traces or secrets.
6. Add `/health` (FastAPI optional) or process health metrics; log every request ID, latency, model version, and outcome.
7. Add test messages and unit tests for normal, invalid, duplicate, and unavailable-model cases.

**Acceptance criteria / deliverables:** One request produces one correlated result; invalid payload returns a safe error; process restarts and reconnects; logs prove latency and model version.

**Common pitfalls:** Fitting encoders at inference; blocking MQTT callback; model/feature mismatch; publishing NumPy types that JSON cannot serialize; treating a model estimate as a sensor measurement.

**Copy-paste prompt:**

> Implement a Python MQTT inference worker for the EV Digital Twin. It must load pre-trained scikit-learn duration and energy pipelines once, subscribe to `evdt/v1/requests/charging`, validate versioned JSON, run inference off the MQTT callback thread, and publish correlated results to `evdt/v1/results/charging`. Include request/message IDs, model metadata, structured errors, reconnect/backoff, health checks, and pytest coverage for invalid and duplicate inputs.

---

## Phase 6 — Node.js/Express backend on Laptop 1

**Objective:** Give the web app one secure HTTP/WebSocket interface while the backend owns MQTT and correlation.

**Prerequisites:** MQTT broker/worker working; MongoDB URI available.

**Tasks:**

1. Create `backend/src/app.js`, `server.js`, `services/mqttClient.js`, `services/predictionService.js`, routes, models, and validators.
2. Implement `POST /api/predictions/charging`: validate input (Zod/Joi), create UUID `requestId`, persist `pending`, publish MQTT QoS 1, then either wait up to 15 seconds or respond `202 Accepted` with the request URL.
3. Subscribe to results on startup. Validate/deduplicate, find by `requestId`, atomically update its status, and emit a Socket.IO event to the correct browser session/dashboard.
4. Provide `GET /api/predictions/:requestId`, `GET /api/stations/:id`, and health endpoints. Keep browser-to-MQTT access out of the initial design.
5. Add CORS allowlist, rate limiting, payload-size limits, centralized error handling, request logs, and environment validation.

**Acceptance criteria / deliverables:** Browser can submit a request and later retrieve a persisted result; a duplicate MQTT result does not create a second prediction; timeout and broker-down errors are usable in the UI.

**Common pitfalls:** Publishing MQTT from the React browser; correlating only by vehicle name; holding HTTP requests indefinitely; trusting incoming MQTT JSON without validation.

**Copy-paste prompt:**

> Build an Express backend for a React EV charging digital twin. The backend, not the browser, must manage MQTT. Add validated REST endpoints to create and retrieve charging predictions, persist pending/completed/timed-out states in MongoDB, publish QoS-1 MQTT requests, subscribe to results, correlate using UUID request IDs, deduplicate messages, and notify the UI through Socket.IO. Include CORS, rate limits, health endpoints, and clean error responses.

---

## Phase 7 — MongoDB data model and history

**Objective:** Persist trusted application state and label source/quality of every signal.

**Tasks:**

1. Create collections: `stations`, `chargers`, `vehicles`, `batteries`, `chargingSessions`, `predictionRequests`, `telemetryReadings`, `alerts`, and `optimizationPlans`.
2. Store `source` (`sensor`, `simulation`, `historical_csv`, `ml_estimate`, `manual`) and `quality`/`units` with readings and predictions.
3. Index `requestId` uniquely; index station/time queries; use TTL only for disposable telemetry if desired.
4. Make `predictionRequests` immutable enough to audit input and result model version. Add a `statusHistory`.
5. Seed a clearly labelled demo station/charger/vehicle set—never present demo data as live telemetry.

**Acceptance criteria / deliverables:** Database schema diagram; migrations/seed script; request-result audit trail; queries power dashboard history.

**Common pitfalls:** No unique request ID; mixing raw telemetry and derived predictions without source; storing passwords in documents; schema that cannot identify a simulated value.

**Copy-paste prompt:**

> Design Mongoose schemas for an EV Charging Station Digital Twin: stations, chargers, vehicles, batteries, charging sessions, prediction requests/results, telemetry, alerts, and optimization plans. Include timestamps, units, source (`sensor`, `simulation`, `historical_csv`, `ml_estimate`, `manual`), data-quality fields, unique request IDs, indexes, and a demo seed script. Preserve model version and input/output auditability.

---

## Phase 8 — React dashboard and user workflow

**Objective:** Build a clear, responsive dashboard that never confuses simulation, estimates, and live readings.

**Tasks:**

1. Create pages: Overview, New Charging Request, Session/Prediction Detail, Battery Health, Telemetry, Alerts, Optimization, and Data Provenance.
2. Make the request form match the versioned schema; validate ranges in the browser and show server errors.
3. Show a visible lifecycle: Draft → Sent → Processing → Completed / Timed out / Failed. Poll the request endpoint and/or receive Socket.IO updates.
4. Display prediction units, generation time, model version, caveats, and confidence/uncertainty if produced. Use badges: **Live sensor**, **Simulated**, **ML estimate**, **Historical**.
5. Use Recharts for trends and accessible tables; show empty/loading/error states and responsive layout.

**Acceptance criteria / deliverables:** A first-time user can submit data, see an explanatory result, locate its source label, and view request history without reading logs.

**Common pitfalls:** Calling Laptop 2 directly from React; treating pending as success; using colour as the only status indicator; hiding uncertainty/limitations.

**Copy-paste prompt:**

> Create a React dashboard for an EV Charging Station Digital Twin. Include pages for station overview, new charging prediction, request history/detail, battery health, telemetry, alerts, and optimization. Integrate only with the Laptop 1 Express API/Socket.IO. Match the request schema, handle pending/timeouts/errors, and clearly badge every number as live sensor, simulated, historical, or ML estimate. Use accessible labels, units, loading states, and charts.

---

## Phase 9 — Three.js digital twin

**Objective:** Build an interactive 3D station that reflects application state rather than a disconnected animation.

**Tasks:**

1. Use React Three Fiber/Drei. Start with primitive geometry: ground, 2–4 bays, chargers, EV blocks, cables, status lights. Use optimized/licensed assets only later.
2. Build `StationScene`, `Charger`, `Vehicle`, `StatusLight`, and `TelemetryPanel` components. Drive them from the same API/store used by the dashboard.
3. Map charger states consistently: available green, charging blue, fault/maintenance red, offline gray. Provide text/ARIA alternatives outside the canvas.
4. Animate only values that have a source. Simulated SOC progress must state “simulated”; live sensor temperature can update a colour/label with its timestamp.
5. Clicking a bay opens a panel with charger status, request ID, source labels, and last update time.

**Acceptance criteria / deliverables:** 3D scene loads on an ordinary laptop, reflects at least one live backend state change, and remains useful with a 2D fallback/table.

**Common pitfalls:** Heavy models causing low FPS; visual values with no data source; permanently animating a charger after a timed-out request; inaccessible canvas-only controls.

**Copy-paste prompt:**

> Implement a React Three Fiber EV charging-station scene with simple performant geometry first. Create reusable Charger, Vehicle, StationScene, and status components driven by the same backend state as the dashboard. Support available/charging/fault/offline states, selectable bays, source/timestamp labels, and accessible non-canvas controls. Clearly mark all simulated SOC/power animations; only actual Arduino readings are live telemetry.

---

## Phase 10 — Arduino UNO R4 temperature sensor integration

**Objective:** Add one safe, real telemetry channel while retaining a simulation fallback.

**Prerequisites:** Arduino UNO R4, known temperature sensor model, approved wiring diagram, USB or network path to a gateway, and no attempt to attach directly to a high-voltage EV system.

**Tasks:**

1. Identify sensor protocol (for example DHT, DS18B20, analog). Use its library and a sample sketch to read stable °C values.
2. Publish through an appropriate gateway. If the board/network setup cannot securely use MQTT, send serial data to a small Laptop 1/Laptop 2 gateway that validates and publishes it. Do not invent Wi-Fi capability for a specific UNO R4 model.
3. Add telemetry schema: `sensorId`, `stationId`, `timestamp`, `temperatureC`, `source: "sensor"`, calibration status, and optional `simulated: false`.
4. Sanity-check range/rate-of-change; store readings; display current value and trend. Add a toggleable simulator that publishes `source: "simulation"` on a different configurable profile.
5. Document sensor location. It measures ambient/charger-enclosure temperature, not EV battery-cell temperature unless a safe approved BMS data feed exists.

**Acceptance criteria / deliverables:** Physical sensor reading reaches dashboard with timestamp and source `sensor`; unplugged/out-of-range state generates a visible sensor-health status; simulation remains clearly marked.

**Common pitfalls:** Unsafe mains/high-voltage work; calling ambient readings “battery temperature”; no calibration; missing timestamps; silently replacing a dead sensor with simulated data.

**Copy-paste prompt:**

> Integrate an Arduino UNO R4 and a known temperature sensor into an EV charging-station digital twin safely. First produce a sensor-read sketch, then a serial or network MQTT gateway that publishes validated, timestamped temperature telemetry with source metadata. Store/display it through the existing backend. Add range checks, sensor-offline alerts, and a separately labelled simulator. Do not connect to EV high voltage or call ambient temperature battery-cell temperature.

---

## Phase 11 — Smart charging optimization

**Objective:** Recommend charger assignment and power allocation under explicit constraints.

**Tasks:**

1. Start with an explainable heuristic: priority score based on deadline, SOC deficit, user priority, charger compatibility, and station capacity.
2. Define inputs: active sessions, charger availability/rating, station max kW, requested target SOC, predicted energy/duration, tariff (if available), and all assumptions.
3. Enforce constraints: each EV uses at most one compatible charger; charger allocation ≤ rating; total allocation ≤ station limit; no negative values.
4. Return a plan with recommendation reason, predicted completion, assigned kW, and whether it relies on simulated inputs. Start with deterministic test cases before using a linear/MILP solver.
5. Publish `optimization` result and show human approval required—do not control physical equipment in this project.

**Acceptance criteria / deliverables:** Test scenario with multiple vehicles never exceeds station/charger capacity; recommendation is explainable and shown as advisory.

**Common pitfalls:** Optimizing unvalidated forecasts as facts; no station power constraint; commanding physical hardware; ignoring fairness/starvation.

**Copy-paste prompt:**

> Build an advisory smart-charging optimizer for a simulated EV station. Start with an explainable priority heuristic, then optionally add a constrained solver. Use predicted energy/duration, deadlines, SOC deficit, charger compatibility, charger limits, and station maximum kW. Enforce all constraints, return a rationale and source labels, publish an MQTT optimization result, and never directly control real chargers.

---

## Phase 12 — Anomaly detection and maintenance alerts

**Objective:** Identify unusual sessions, sensor readings, and service failures without overstating fault diagnosis.

**Tasks:**

1. Define explicit rule alerts first: temperature beyond safe project threshold, impossible SOC, broker/service offline, prediction timeout, predicted vs observed deviation (when observed data exists).
2. Train Isolation Forest only on clean, comparable historical features and set threshold using validation/review samples. Label output as “anomaly score,” not confirmed fault.
3. Include alert severity, affected asset, evidence, timestamp, source, status (open/acknowledged/resolved), and recommended inspection action.
4. Deduplicate/rate-limit alerts and publish to `evdt/v1/alerts`; persist and display them.
5. Test threshold crossing, repeated MQTT message, recovery, and sensor outage scenarios.

**Acceptance criteria / deliverables:** Alert lifecycle works end-to-end; no alert storm for the same condition; dashboard explains that anomaly ≠ confirmed failure.

**Common pitfalls:** Training anomaly detection on unclean data; using CSV-only data to claim charger fault prediction; alerting on every noisy reading; no acknowledgement workflow.

**Copy-paste prompt:**

> Implement explainable anomaly detection and alerts for an EV Digital Twin. Start with tested engineering/data-quality rules, then add Isolation Forest only for suitable clean historical features. Publish/persist deduplicated alerts with severity, evidence, source, lifecycle status, and a recommended human action. Clearly state that an anomaly is not a confirmed hardware fault, especially where telemetry is simulated.

---

## Phase 13 — End-to-end integration

**Objective:** Connect all layers into a controlled, observable demo.

**Tasks:**

1. Write a contract test using the shared JSON examples: backend publish → Python response → backend persistence → UI update.
2. Add correlation and tracing to logs: `requestId`, `messageId`, station ID, topic, timestamps, and model version.
3. Bring up services in order: MongoDB, Mosquitto, Python worker, Express, React. Create a start checklist/script for each laptop.
4. Run demo modes: (a) historical CSV replay, (b) simulated live session, (c) live Arduino temperature, (d) broker unavailable, (e) inference timeout.
5. Use a live status page showing each service connection and the last message time.

**Acceptance criteria / deliverables:** Repeated 10-request demo completes with results matched to correct request IDs; status page identifies an intentionally stopped component; no mixed source labels.

**Common pitfalls:** Testing only happy path; manual configuration that cannot be repeated; misattributing a historical/simulated value to a sensor; starting frontend before its API contract exists.

**Copy-paste prompt:**

> Create an end-to-end integration checklist and automated contract tests for a two-laptop MQTT EV Digital Twin. Verify the path React → Express → Mosquitto → Python ML → Mosquitto → Express/MongoDB → React/Three.js. Include correlation IDs, service health, CSV replay, simulated session, live Arduino temperature, broker-down, invalid-message, and timeout tests. Produce a concise demo runbook.

---

## Phase 14 — Testing and evaluation

**Objective:** Demonstrate correctness, reliability, and model limitations with evidence.

**Tasks:**

1. Unit-test schema validators, feature preparation, predictions, optimizer constraints, alert rules, and source labels.
2. Integration-test MQTT request/result correlation, duplicate QoS 1 delivery, reconnect, invalid JSON, authentication failure, and timeout.
3. UI-test form validation, states, accessibility, and 3D state synchronization. Test on the actual LAN.
4. Evaluate duration/energy models on held-out data with MAE/RMSE/R² and report uncertainty/limitations. Evaluate SOH/RUL only on separate battery IDs in the aging dataset.
5. Record load/latency for representative requests and a known 10–50 request burst. Define pass thresholds before observing results.

**Acceptance criteria / deliverables:** Test report, screenshots/logs, model cards, defect list/resolution, and reproducible commands.

**Common pitfalls:** Calling a model accurate without held-out evaluation; mixing results from different data sources; only testing on one laptop; measuring latency without including broker/network time.

**Copy-paste prompt:**

> Write a complete test plan and starter automated tests for a two-laptop EV charging Digital Twin. Cover unit, integration, UI, MQTT reliability/security, model evaluation, and failure cases. Include pass/fail criteria, QoS-1 duplicates, timeout/reconnect, source-label correctness, and separate evaluation protocols for charging predictions versus battery SOH/RUL. Do not overclaim accuracy or physical validation.

---

## Phase 15 — Deployment, demonstration, and documentation

**Objective:** Make the project easy to start, explain, assess, and safely hand over.

**Tasks:**

1. Create version-pinned dependency files: `package-lock.json`/`npm ci`, `requirements.txt` or `pyproject.toml`, model metadata, and `.env.example`.
2. Add startup methods: systemd/launchd/Task Scheduler or simple documented scripts. Configure restart-on-failure for Mosquitto and the Python worker where appropriate.
3. Document architecture, network ports, topic map, schemas, API endpoints, database model, security controls, and backup/restore steps.
4. Create model cards/data cards with dataset limitations and a simulated-versus-real signal table.
5. Prepare a 5–7 minute demonstration: architecture, submit request, show result, show 3D state, show Arduino reading, simulate timeout, show alert/optimizer, state limitations and future work.
6. Include a troubleshooting section: wrong broker IP, firewall, port, credentials, missing model file, MongoDB unavailable, unsupported Arduino connection.

**Acceptance criteria / deliverables:** Fresh-machine or clean-environment startup guide; final README; architecture diagram; demo script; model/data cards; test report; presentation/report assets.

**Common pitfalls:** Hard-coded IPs/secrets; unreproducible notebook-only training; demo hiding errors; claiming sensor data measures battery health when it measures ambient temperature.

**Copy-paste prompt:**

> Package and document a two-laptop EV Charging Station Digital Twin for a college demonstration. Produce reproducible install/start instructions, environment templates, service startup scripts, architecture/topic/schema/API documentation, model and data cards, testing evidence, troubleshooting, and a 5–7 minute demo script. Include an explicit table distinguishing historical data, ML estimates, simulated telemetry, and real Arduino ambient-temperature readings.

---

## Final readiness checklist

- [ ] The original CSV is preserved and a cleaning report exists.
- [ ] Duration and energy models have held-out metrics and versioned artifacts.
- [ ] SOH/degradation/RUL use a separate longitudinal aging dataset and are labelled as estimates/domain-limited.
- [ ] Laptop 2 hosts authenticated Mosquitto on the LAN; Laptop 1 reaches it by Laptop 2 IP, not localhost.
- [ ] Every request/result has `requestId`, `messageId`, timestamp, schema version, timeout, and duplicate handling.
- [ ] Browser communicates with Laptop 1 backend—not directly with MQTT/ML service.
- [ ] MongoDB records source, units, model version, and status history.
- [ ] Arduino readings are real only when received from the sensor; simulated values are visibly labelled.
- [ ] Optimization is advisory; it does not operate a real charger.
- [ ] The final demo includes both success and failure paths.

## Recommended first demonstration

1. Start MongoDB, Mosquitto, Python worker, Express backend, then React app.
2. On Laptop 1, enter a vehicle, starting/target SOC, charger type/rate, and temperature source.
3. Backend assigns a UUID, stores `pending`, and publishes the MQTT request.
4. Laptop 2 validates the payload and produces duration/energy predictions from local models.
5. Laptop 1 receives the result, records it, and updates dashboard and 3D charger state.
6. Show the exact request ID, model version, units, source labels, and any warnings.

This is the complete core. Once it is reliable, build out SOH/RUL, real sensor telemetry, anomaly detection, and optimization in the phases above.
