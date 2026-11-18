# EV Charging Station Digital Twin (DT_EV-Battery)

A digital twin of an EV charging station that runs across three laptops. A driver enters a vehicle and a charging
request in a web dashboard. Machine-learning models trained on **real public datasets** then predict the
**charging time, energy, cost, battery wear, state of health (SOH) and remaining useful life (RUL)**. A **live
Arduino temperature sensor** feeds the station's ambient temperature into the prediction through **OPC UA** and
**MQTT**. A **3D model** of the station shows its current state.

The project is a working prototype for teaching and demonstration. It never switches or limits a real charger, and
its battery numbers are model estimates, not BMS readings (see [Limitations](#11-limitations)).

---

## Contents

1. [What it does](#1-what-it-does)
2. [Architecture](#2-architecture)
3. [Data pipelines](#3-data-pipelines)
4. [Datasets](#4-datasets)
5. [Models and their scores](#5-models-and-their-scores)
6. [Repository layout](#6-repository-layout)
7. [Tech stack](#7-tech-stack)
8. [Setup and running](#8-setup-and-running)
9. [Using the dashboard](#9-using-the-dashboard)
10. [Testing](#10-testing)
11. [Limitations](#11-limitations)
12. [Further documentation](#12-further-documentation)

---

## 1. What it does

| Feature | Description |
|---|---|
| **Charging prediction** | For a vehicle model, battery size, vehicle age, start/target SOC, charger type (Level 1, Level 2, DC fast) and ambient temperature, it predicts charging duration, grid energy (kWh) and cost (USD) |
| **Battery health** | Each request also gets an estimated SOH, a battery-wear factor for this charge, battery wear % and RUL in cycles |
| **Live sensor** | An LM35 sensor on an Arduino UNO R4 WiFi measures ambient air temperature. The value goes Arduino → OPC UA → MQTT → dashboard every 5 s, and a request can use it as its temperature |
| **Distributed ML** | The browser talks only to the web backend. The backend sends requests to a separate ML worker over MQTT and gets results back, with timeout, retry and duplicate handling |
| **History and provenance** | Every request, result, reading and alert is stored in MongoDB. Each stored value says where it came from (`sensor`, `ml_estimate`, `physics_estimate`, `simulation`, `manual`) and how far it can be trusted |
| **3D digital twin** | A Three.js scene of the station: charger bays, vehicles, status lights and the temperature panel, all driven by real backend state |
| **Alerts** | For example, a `sensor_offline` alert opens when live readings stop for 30 s and resolves itself when they return |

---

## 2. Architecture

### 2.1 Three laptops

| Machine | OS | Runs | Port | Repo folder |
|---|---|---|---|---|
| **Sensor laptop** | Windows | Arduino on USB + **OPC UA server** | 4840 | [`laptop-sensor/`](laptop-sensor/) |
| **ML laptop** | macOS | **Mosquitto** MQTT broker, **Python ML worker**, **OPC UA → MQTT bridge** | 1883 | [`laptop-2/`](laptop-2/) |
| **Web laptop** | Windows | **Node/Express backend**, **React frontend**, MongoDB (local or Atlas) | 3000, 5173 | [`laptop-1/`](laptop-1/) |

> The folder names come from the original two-laptop plan: `laptop-1/` is the web laptop, `laptop-2/` is the Mac, and
> `laptop-sensor/` is the laptop with the Arduino.

All three must be on the same Wi-Fi/LAN. The browser only ever talks to the web laptop.

### 2.2 Diagram

```
                        ┌──────────────────────────── SENSOR LAPTOP (Windows) ───────────────────────────┐
 LM35 ──> Arduino UNO ──USB/COM6──> serial reader ──> 5 s sampler ──> OPC UA server  opc.tcp://<ip>:4840/evdt
 (A0)    R4 WiFi                                                        node EVChargingStation/AmbientSensor/TemperatureC
                        └───────────────────────────────────────────────────────┬────────────────────────┘
                                                                                │ OPC UA subscription
                        ┌──────────────────────────── ML LAPTOP (Mac) ──────────▼────────────────────────┐
                        │  opcua_bridge/bridge.py ──MQTT──> Mosquitto :1883 <──MQTT──> ml_service/main.py │
                        │                                     (auth + ACL)              (scikit-learn)    │
                        └───────────────────────────────────────┬────────────────────────────────────────┘
                                                                │ MQTT (requests / results / telemetry / alerts)
                        ┌──────────────────────────── WEB LAPTOP (Windows) ─────▼────────────────────────┐
                        │  Express backend :3000 ──> MongoDB                                             │
                        │        │ REST + Socket.IO                                                      │
                        │        ▼                                                                       │
                        │  React + Three.js dashboard :5173  (browser)                                   │
                        └────────────────────────────────────────────────────────────────────────────────┘
```

### 2.3 Why each technology

| Link | Technology | Why |
|---|---|---|
| Arduino → sensor laptop | USB serial, 9600 baud | No Wi-Fi credentials or broker passwords on the board. The sketch only prints `Temperature: 31.26 °C` |
| Sensor laptop → Mac | **OPC UA** (node-opcua server, asyncua client) | The industrial standard for exposing device data. Typed values with status codes and source timestamps, and a subscription so the Mac is notified of each new value |
| Mac ↔ web laptop | **MQTT** (Mosquitto) | Lightweight publish/subscribe with QoS 1. It decouples the web app from the ML worker |
| Web laptop ↔ browser | REST + **Socket.IO** | The browser gets live updates without polling and never needs MQTT access |
| Storage | **MongoDB** | Flexible documents for requests, results, telemetry, alerts and provenance |

### 2.4 MQTT topics

All topics start with `evdt/v1/`, all use QoS 1, and every message is validated against a JSON Schema in
[`shared/schemas/`](shared/schemas/).

| Topic | Publisher → Subscriber | Schema |
|---|---|---|
| `requests/charging` | backend → ML worker | `charging-request.schema.json` |
| `results/charging` | ML worker → backend | `charging-result.schema.json` |
| `results/health` | ML worker → backend | `health-result.schema.json` |
| `results/optimization` | ML worker → backend | reserved for the optimiser (not built yet) |
| `telemetry/temperature` | OPC UA bridge (real sensor) or simulator → backend, ML worker | `telemetry-temperature.schema.json` |
| `alerts` | ML worker → backend | `alert.schema.json` |
| `stations/{id}/status` | backend → clients (**retained**) | `station-status.schema.json` |

Broker users (prototype credentials for a trusted LAN only):

| User | Password | Publishes | Used by |
|---|---|---|---|
| `backend` | `backend_pass_2026` | requests, station status | web backend |
| `mlworker` | `mlworker_pass_2026` | results, alerts | ML worker |
| `opcbridge` | `opcbridge_pass_2026` | telemetry/temperature only | OPC UA bridge |
| `sensor` | `sensor_pass_2026` | telemetry/temperature only | temperature simulator |
| `admin` | `admin_pass_2026` | everything | debugging, MQTT archiver |

Full topic map: [`shared/schemas/TOPIC_MAP.md`](shared/schemas/TOPIC_MAP.md).

---

## 3. Data pipelines

### 3.1 Charging request (runtime)

```
1. Browser       POST /api/predictions/charging            (vehicle, SOC, charger, temperature source)
2. Backend       validates (zod) → if source = "sensor", replaces the temperature with the newest stored
                 sensor reading (refused with 409 SENSOR_NOT_LIVE if it is offline or suspect)
                 → saves the request as "pending" in MongoDB
                 → publishes to evdt/v1/requests/charging, starts a 15 s timer
3. ML worker     validates against the JSON Schema, removes duplicates by requestId
                 → physics: usable capacity, SOC window, temperature effects, charge taper
                 → Level 1/2: duration and cost from the Palo Alto models; DC fast: physics + price
                 → battery: SOH from vehicle age, wear factor / wear % / RUL from the ISU cycle-life model
                 → publishes results/charging and results/health
4. Backend       validates the result, ignores duplicates, updates the request to "completed"
                 (or "timed_out" after 15 s, which can be retried with the same requestId)
                 → pushes the update to the browser over Socket.IO
5. Browser       shows duration, energy, cost, wear, SOH, RUL, with an "ML estimate" or
                 "Physics estimate" badge and the model versions used
```

### 3.2 Live temperature (runtime)

```
Arduino prints a reading every ~2.2 s (20-sample average, 12-bit ADC)
 → sensor laptop: parse the line, reject impossible values (outside −50…85 °C, e.g. a loose wire),
   apply the calibration offset, keep only the newest reading every 5 s
 → OPC UA node TemperatureC: value + SourceTimestamp (when the reading arrived), status Good
   (BadWaitingForInitialData before the first reading; BadNoCommunication after 30 s without one)
 → Mac bridge: subscription (trigger StatusValueTimestamp) → builds the telemetry message
   (source "sensor", simulated false) → validates → publishes QoS 1 as opcbridge
   (nothing is published while the status is Bad or a link is down; no duplicates after reconnects)
 → backend: rate check (> 1 °C/s change = suspect), stores it, Socket.IO update,
   opens/resolves the sensor_offline alert
 → New request page: "● Live · LM35-A0-01 · 31.26 °C · read 1 s ago", value follows the sensor
```

### 3.3 Training (offline, on the Mac)

```
download_datasets.py  ─┬─> prepare_sessions.py ──> train_session_models.py      → session_duration / cost / idle .joblib
 (NASA, ISU, Palo Alto, │
  ACN; about 10.5 GB)   ├─> prepare_isu.py ──────> train_battery_degradation.py → battery_life / battery_rul .joblib
                        └─> prepare_nasa.py ─────> train_battery_soh.py          → soh.joblib
study_ev_charging_patterns.py  → shows the synthetic Kaggle CSV has no learnable signal
```

Rules used for every model:
- **95/5 split by group**, never by random rows: by driver (sessions), by battery (NASA) or by test condition
  (ISU). No driver or cell appears in both train and test.
- The model is **chosen by grouped cross-validation on the 95 %**, never by the test set.
- Each model is compared with a "predict the average" baseline and, where one exists, a formula baseline.
- Each saved model has a `*_model_metadata.json` with its features, all candidate scores, split and training date.

---

## 4. Datasets

| Dataset | Size | Licence | Used for |
|---|---|---|---|
| **City of Palo Alto EV charging sessions** (2011–2020) | 259,415 sessions, 47 Level 1/2 stations (252,841 after cleaning) | City open data | charging time, cost, idle time |
| **Caltech ACN-Data** (Caltech, JPL, office) | 66,745 sessions | registration token | external test of the charging-time model |
| **ISU-ILCC Battery Aging** (Li et al., 2023) | 251 NMC/graphite pouch cells, 63 charge/discharge/DoD conditions | CC BY 4.0 | cycle life, RUL, battery wear |
| **NASA PCoE Battery Data Set** (Saha & Goebel, 2007) | 34 LiCoO2 18650 cells (15 used, 2,483 discharge cycles) | public domain | SOH from the charging curve |
| `Data/ev_charging_patterns.csv` | 1,320 rows | Kaggle | **not used for training**: it is synthetic, and its targets are statistically independent of every input (permutation test). Used for the Phase 1–2 analysis and imported as demo session history only |

Download with `python src/download_datasets.py nasa isu isu-raw paloalto acn` in `laptop-2/`. Raw files are not
committed. Sources, citations and processing details are in
[`laptop-2/data/battery_aging/data_card.md`](laptop-2/data/battery_aging/data_card.md).

---

## 5. Models and their scores

All scores are on drivers, cells or conditions the model never saw in training.

### 5.1 Charging sessions (Palo Alto)

| Output | Model | Test error | Test R² | Baseline |
|---|---|---|---|---|
| Charging time, Level 1/2 | physics time × learned correction (HistGradientBoosting, MAE loss) | 0.183 h (≈ 11 min) | 0.918 | formula 0.201 h / R² 0.888; average 0.948 h |
| Cost, Level 1/2 | learned $/kWh tariff + learned extra fees (HistGradientBoosting) | $0.20 (CV $0.13) | 0.69 (CV 0.82) | flat $0.23/kWh: $0.23 / R² 0.59 |
| Idle time after charging | HistGradientBoosting | 0.51 h | 0.15 | stored only, not used in predictions |

- The cost model learned **$0.2301/kWh** from the fees alone; Palo Alto's published rate is $0.23/kWh.
- External test on 44,724 ACN sessions from other sites: 0.97 h error, R² 0.44 (formula: 1.03 h, R² 0.39). ACN uses
  smart charging that slows cars down to share power.

### 5.2 Battery (ISU-ILCC and NASA)

| Output | Model | Score |
|---|---|---|
| Cycle life (EFC to 80 %) from charge rate, discharge rate, depth of discharge | polynomial ridge | ≈ 29 % error (cells under identical conditions already differ by ≈ 18 %) |
| RUL (remaining EFC to 80 %) | HistGradientBoosting | 115 EFC, R² 0.77 (CV); 195 EFC, R² 0.72 (held-out conditions) |
| SOH from the 3.9–4.2 V part of a CC-CV charge | ridge | 2.8 percentage points, R² 0.84 (each battery held out once) |
| Early life prediction | Gaussian process | 25.3 % → 20.7 % error when the voltage curve after 25 EFC is added |

### 5.3 What each prediction uses

| Output | Level 1 / Level 2 | DC fast |
|---|---|---|
| Duration | Palo Alto model | physics (no public DC session data) |
| Energy | physics: SOC window × usable capacity ÷ efficiency (efficiency drops in cold/heat) | same |
| Cost | Palo Alto model | energy × `PRICE_DCFC_USD_PER_KWH` (default $0.48) |
| SOH | fleet average from vehicle age (≈ 1.8 %/year, floor 70 %) | same |
| Wear factor, wear %, RUL | ISU cycle-life model, relative to a gentle reference charge (0.5C, 50 % DoD), scaled to an assumed 2,000-EFC pack life | same |

The physics part (`laptop-2/ml_service/charging_physics.py`) models charger and vehicle power limits (on-board AC
charger and peak DC acceptance for the BMW i3, Chevy Bolt, Hyundai Kona, Nissan Leaf and Tesla Model 3), the SOC
charge taper above ≈ 80 %, and cold-weather current limits.

Example outputs:

| Request | Time | Energy | Cost | Wear factor |
|---|---|---|---|---|
| Tesla Model 3, 20→80 %, DC 250 kW | 20 min | 45.8 kWh | $21.97 | 1.10 |
| Tesla Model 3, 20→80 %, Level 2 11.5 kW | 4 h 40 min | 47.3 kWh | $10.88 | 1.10 |
| Nissan Leaf, 20→80 %, Level 1 | 16 h 10 min | 25.7 kWh | $5.91 | 1.10 |
| Chevy Bolt, 10→90 %, Level 2, −5 °C | 9 h 58 min | 62.8 kWh | $14.45 | 1.34 |
| BMW i3, 10→100 %, DC 50 kW | 1 h 5 min | 39.9 kWh | $19.16 | 1.47 |

---

## 6. Repository layout

```
DT_EV-Battery/
├── laptop-sensor/                 Sensor laptop: Arduino → OPC UA server (Node)
│   ├── src/serial.js              read and check "Temperature: …" lines, auto-detect the Arduino
│   ├── src/sampler.js             newest reading every 5 s
│   ├── src/opcuaServer.js         OPC UA address space, status codes, read-only
│   ├── src/main.js                npm run opcua:server
│   └── test/
├── laptop-2/                      Mac: broker, ML worker, OPC UA bridge, training (Python)
│   ├── mosquitto/                 mosquitto.conf, passwd, acl
│   ├── ml_service/                MQTT inference worker (main.py, predictors, physics, battery health)
│   ├── opcua_bridge/bridge.py     OPC UA client → MQTT publisher
│   ├── src/                       dataset download, preparation and training scripts
│   ├── models/                    trained .joblib models + metadata JSON
│   ├── data/battery_aging/        data card + processed parquet files
│   ├── notebooks/                 data quality / EDA notebook
│   └── tests/                     worker and bridge tests (pytest)
├── laptop-1/                      Web laptop
│   ├── arduino/temperature_lm35/  Arduino sketch (LM35 on A0)
│   ├── backend/                   Express API, MQTT client, MongoDB models, Socket.IO
│   │   ├── src/routes/            REST endpoints
│   │   ├── src/services/          prediction, ingest, sensor monitor, station, sessions
│   │   ├── src/models/            Mongoose models
│   │   └── scripts/               db setup, dev broker, stub worker, telemetry simulator, MQTT archiver
│   └── frontend/                  React + Vite dashboard, Three.js twin (src/twin/)
├── shared/schemas/                JSON Schemas for every MQTT message + TOPIC_MAP.md
├── docs/                          connection guide, battery model limitations
├── what_I_did/                    detailed write-up of every phase, with screenshots
├── Implementation_plan.md         original project plan
└── OPC-UA_implementation-plan.md  OPC UA design and decisions
```

### 6.1 Backend REST API (`http://localhost:3000`)

| Method & path | Purpose |
|---|---|
| `GET /api/health` | MongoDB, broker and ML worker status |
| `POST /api/predictions/charging` | create a charging request |
| `GET /api/predictions`, `GET /api/predictions/:requestId` | history and one request |
| `POST /api/predictions/:requestId/retry` | retry a timed-out request |
| `GET /api/stations/:stationId`, `GET /api/stations/:stationId/chargers` | station state (including `sensorTelemetry`) |
| `PATCH /api/stations/:stationId/chargers/:chargerId` | change a charger's state |
| `GET /api/sessions`, `GET /api/sessions/summary`, `POST /api/sessions/simulated`, `POST /api/sessions/:id/stop` | charging sessions (simulated) |
| `GET /api/telemetry`, `GET /api/telemetry/latest` | temperature history |
| `GET /api/alerts`, `PATCH /api/alerts/:alertId` | alerts and acknowledging them |
| `GET /api/meta`, `/api/vehicles`, `/api/battery-health`, `/api/optimization/plans`, `/api/provenance` | reference data for the dashboard |

MongoDB collections: `predictionRequests`, `stations`, `chargers`, `chargingSessions`, `vehicles`, `batteries`,
`telemetryReadings`, `healthEstimates`, `alerts`, `optimizationPlans`.

---

## 7. Tech stack

| Part | Technologies |
|---|---|
| Sensor | Arduino UNO R4 WiFi, LM35; Node 20+, `serialport` 13, `node-opcua` 2.187 |
| ML | Python 3.11–3.13, scikit-learn 1.8, pandas, numpy, scipy, pyarrow, joblib, paho-mqtt 2.2, asyncua 2.1, jsonschema |
| Broker | Eclipse Mosquitto 2 (password file + ACL) |
| Backend | Node 20+, Express 5, Mongoose 8, mqtt.js 5, Socket.IO 4, zod, ajv, helmet, pino |
| Frontend | React 19, Vite, React Router 7, Recharts, Three.js with @react-three/fiber and drei |
| Database | MongoDB (local or Atlas) |
| Tests | node:test + supertest, Vitest + Testing Library, pytest |

---

## 8. Setup and running

The step-by-step guide with expected output and a troubleshooting table is
[`docs/connection.md`](docs/connection.md). The short version follows.

### 8.1 Prerequisites

| Laptop | Install |
|---|---|
| Sensor laptop (Windows) | Node.js 20+, Arduino IDE (to upload the sketch once) |
| ML laptop (Mac) | Python 3.11–3.13, Mosquitto (`brew install mosquitto`) |
| Web laptop (Windows) | Node.js 20+, MongoDB (local) or a MongoDB Atlas connection string |
| All | same Wi-Fi/router, automatic time sync on, fixed IPs (router DHCP reservation) recommended |

### 8.2 One-time setup

**ML laptop (Mac)**
```bash
cd laptop-2
python3.13 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp ml_service/.env.example ml_service/.env
cp opcua_bridge/.env.example opcua_bridge/.env      # set OPCUA_URL=opc.tcp://<sensor laptop IP>:4840/evdt
```
The trained `.joblib` models are in `laptop-2/models/`. To retrain them from scratch:
```bash
python src/download_datasets.py nasa isu isu-raw paloalto acn
python src/prepare_sessions.py && python src/train_session_models.py
python src/prepare_isu.py      && python src/train_battery_degradation.py
python src/prepare_nasa.py     && python src/train_battery_soh.py
```

**Web laptop**
```bash
cd laptop-1/backend
npm install
copy .env.example .env      # set MQTT_HOST = Mac's IP, MONGODB_URI = your database
npm run db:setup            # indexes, demo station + 4 chargers + 5 vehicles, CSV as historical sessions
cd ../frontend
npm install
```

**Sensor laptop**
1. Upload `laptop-1/arduino/temperature_lm35/temperature_lm35.ino` to the Arduino (LM35 output on A0, powered from 5 V).
2. Install the package:
   ```powershell
   cd laptop-sensor
   npm install
   copy .env.example .env
   ```
3. Allow OPC UA through the firewall (PowerShell as administrator):
   ```powershell
   New-NetFirewallRule -DisplayName "EVDT OPC UA 4840" -Direction Inbound -Protocol TCP -LocalPort 4840 -Action Allow -Profile Private
   ```

### 8.3 Every time (start order does not matter; everything reconnects by itself)

| # | Where | Command |
|---|---|---|
| 1 | Mac | `cd laptop-2 && mosquitto -c mosquitto/mosquitto.conf -v` |
| 2 | Mac | `cd laptop-2/ml_service && source ../.venv/bin/activate && python main.py` |
| 3 | Sensor laptop | close the Arduino IDE Serial Monitor, then `cd laptop-sensor && npm run opcua:server` |
| 4 | Mac | `cd laptop-2 && source .venv/bin/activate && python opcua_bridge/bridge.py` |
| 5 | Web laptop | `cd laptop-1/backend && npm start` |
| 6 | Web laptop | `cd laptop-1/frontend && npm run dev`, then open <http://localhost:5173> |

Steps 3 and 4 are only needed for the live sensor. Without them, a request can use a manual or simulated
temperature.

### 8.4 Running on one machine (development)

You can run everything on one computer without Mosquitto or the Mac:

```bash
cd laptop-1/backend
npm run dev:broker          # in-process MQTT broker (aedes) on 1883
npm run dev:stub-worker     # stand-in ML worker: simple formula, NOT the trained models (labelled as such)
npm run dev:sim-telemetry   # simulated temperature readings (labelled "simulation")
npm run dev                 # backend with auto-reload
```
Set `MQTT_HOST=127.0.0.1` in `laptop-1/backend/.env` for this mode.

### 8.5 Checking that it works

- `GET http://localhost:3000/api/health` shows `"mqtt": {"connected": true}` and a recent `mlWorker.lastResultAt`.
- Watch all MQTT traffic: `mosquitto_sub -h <Mac IP> -u admin -P admin_pass_2026 -t 'evdt/v1/#' -v`
- The sensor laptop prints `31.26 °C  LM35-A0-01  -> OPC UA TemperatureC (Good)` every 5 s, and the bridge prints
  `-> MQTT evdt/v1/telemetry/temperature` for each reading.
- Any OPC UA client (UaExpert, Prosys OPC UA Browser) can connect anonymously to `opc.tcp://<sensor IP>:4840/evdt`
  and browse `Objects/EVChargingStation/AmbientSensor/TemperatureC`.

---

## 9. Using the dashboard

| Page | Path | What you see |
|---|---|---|
| Overview | `/` | station summary, charger bays, live temperature, link to the 3D view |
| Station twin (3D) | `/twin` | Three.js model of the station driven by real backend state |
| New request | `/requests/new` | the request form. The Environment box shows the sensor status, and **Live sensor** is picked automatically when the Arduino is live |
| Request history | `/requests` | all requests with status, duration, energy and cost |
| Request detail | `/requests/:id` | result tiles (time, energy, cost, wear, SOH, RUL), model versions, the sensor reading used, retry for timed-out requests |
| Battery health | `/battery` | SOH/RUL estimates, the datasets and the scores on unseen cells |
| Telemetry | `/telemetry` | temperature history, with real sensor and simulated readings kept apart |
| Alerts | `/alerts` | open/acknowledged/resolved alerts (e.g. `sensor_offline`) |
| Optimization | `/optimization` | placeholder for charger-assignment plans (optimiser not built yet; advice only) |
| Provenance | `/provenance` | where every kind of value comes from and how far to trust it |

Labels are never mixed: **Live sensor**, **ML estimate**, **Physics estimate**, **Simulation** and **Manual** each
have their own badge.

---

## 10. Testing

| Suite | Command | Tests |
|---|---|---|
| Sensor laptop | `cd laptop-sensor && npm test` | 19: parsing, mock serial port, sampler, a real OPC UA server checked with a real OPC UA client |
| ML worker + bridge | `cd laptop-2 && python -m pytest tests` | 37: 28 worker (schema, duplicates, behaviour checks such as "DC is faster than Level 2", "cold is slower"), 9 bridge (including a full run against an in-process OPC UA server) |
| Backend | `cd laptop-1/backend && npm test` | 62: REST, MQTT, timeout/retry, ingest, sensor health, offline alert |
| Frontend | `cd laptop-1/frontend && npm test` | 33: form, live sensor, request flow; `npm run build` for the production build |

The whole chain was also checked end-to-end with the real Arduino: readings arrived every 5 s, a "Live sensor"
request stored the board's temperature (not the browser's), and stopping the sensor opened the `sensor_offline`
alert, which resolved itself on restart.

---

## 11. Limitations

- **Battery numbers are estimates.** SOH is a fleet average from vehicle age, not a BMS reading. Wear and RUL use
  the *relative* effect of charge rate and depth of discharge from small lab cells, scaled to an **assumed**
  2,000-cycle pack life, and ignore calendar aging. The NASA SOH model is trained but not used live, because the
  station does not stream charger voltage.
- **Charging data is Level 1/2 only.** There is no public DC fast-charging session data, so DC predictions are physics-based.
- **The sensor measures ambient air**, not battery temperature. The LM35 is uncalibrated (±0.5–1 °C) and cannot
  read below ≈ +2 °C with this wiring.
- **Security is for a trusted LAN demo:** OPC UA has no encryption or login (read-only), and MQTT uses plain TCP with
  prototype passwords. Do not expose ports 1883 or 4840 to the internet.
- Readings are not buffered while a link is down, so gaps stay gaps and stale values are never replayed as live.
- Only advice: the project never controls a real charger.

Details and what may or may not be claimed: [`docs/battery_model_limitations.md`](docs/battery_model_limitations.md).

---

## 12. Further documentation

| Document | Contents |
|---|---|
| [`docs/connection.md`](docs/connection.md) | full multi-laptop setup, credentials, troubleshooting |
| [`docs/battery_model_limitations.md`](docs/battery_model_limitations.md) | battery model scope and honest claims |
| [`shared/schemas/TOPIC_MAP.md`](shared/schemas/TOPIC_MAP.md) | MQTT topics, QoS, retained messages, IDs, timeouts |
| [`OPC-UA_implementation-plan.md`](OPC-UA_implementation-plan.md) | OPC UA design and decisions |
| [`Implementation_plan.md`](Implementation_plan.md) | the original phased project plan |
| [`laptop-2/data/battery_aging/data_card.md`](laptop-2/data/battery_aging/data_card.md) | dataset sources, licences, processing |

Phase write-ups in [`what_I_did/`](what_I_did/):

| Phase | Topic |
|---|---|
| [1](what_I_did/phase1.md) | inspect, clean and explore the charging CSV |
| [2](what_I_did/phase2.md) | first duration/energy models |
| [3](what_I_did/phase3.md) | battery SOH, degradation, RUL |
| [4](what_I_did/phase4.md) | Mosquitto broker and message contract |
| [5](what_I_did/phase5.md) | Python MQTT inference worker |
| [6](what_I_did/phase6.md) | Express backend |
| [7](what_I_did/phase7.md) | MongoDB data model and history |
| [8](what_I_did/phase8.md) | React dashboard |
| [9](what_I_did/phase9.md) | Three.js digital twin |
| [10](what_I_did/phase10.md) | real datasets and retrained models |
| [10 (Arduino)](what_I_did/phase10_arduino.md) | live Arduino temperature sensor |
| [12](what_I_did/phase12_opcua.md) | OPC UA: sensor laptop → Mac bridge → MQTT |
