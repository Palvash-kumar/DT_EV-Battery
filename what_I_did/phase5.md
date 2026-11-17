# Phase 5 — Python MQTT Inference Worker

> **What this phase is about:** Turn the saved scikit-learn model pipelines (from Phase 2) into a robust MQTT request/response service on Laptop 2. The worker loads models once at startup, subscribes to `evdt/v1/requests/charging`, validates incoming JSON against the Phase 4 schema, runs duration and energy inference off the MQTT callback thread, and publishes correlated results to `evdt/v1/results/charging`. It handles deduplication, reconnection, structured error responses, and health logging.

---

## 1. Dependencies Installed

```bash
cd laptop-2
source .venv/bin/activate
pip install paho-mqtt python-dotenv pytest
```

| Package | Version | Purpose |
|---|---|---|
| `paho-mqtt` | 2.2.0 | MQTT v3.1.1 client with auto-reconnect |
| `python-dotenv` | 1.2.4 | Load `.env` file into `os.environ` |
| `pytest` | 9.2.0 | Unit test runner |

Pre-existing: `scikit-learn 1.9.1`, `joblib 1.6.0`, `jsonschema 4.26.0`, `pandas`, `numpy`.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────┐
│  Laptop 2 — ML Worker Process                       │
│                                                      │
│  ┌──────────┐    ┌────────────┐    ┌──────────────┐  │
│  │ config.py│───▶│ main.py    │───▶│ mqtt_client  │  │
│  │ (.env)   │    │ (entry pt) │    │ (paho-mqtt)  │  │
│  └──────────┘    └────┬───────┘    └──────┬───────┘  │
│                       │                   │          │
│                       ▼                   │          │
│               ┌──────────────┐            │          │
│               │ ThreadPool   │            │          │
│               │ (2 workers)  │            │          │
│               └──────┬───────┘            │          │
│                      │                    │          │
│         ┌────────────┼────────────┐       │          │
│         ▼            ▼            ▼       │          │
│  ┌────────────┐ ┌──────────┐ ┌────────┐  │          │
│  │ schemas.py │ │predictors│ │ dedup  │  │          │
│  │ (validate) │ │ (.joblib)│ │ cache  │  │          │
│  └────────────┘ └──────────┘ └────────┘  │          │
│                      │                    │          │
│                      ▼                    │          │
│               publish result ─────────────┘          │
└──────────────────────────────────────────────────────┘
         │                           ▲
         ▼                           │
  evdt/v1/results/charging    evdt/v1/requests/charging
         │                           │
         ▼                           │
   ┌──────────────────────────────────┐
   │      Mosquitto MQTT Broker       │
   └──────────────────────────────────┘
```

**Key design:** The MQTT callback dispatches to a `ThreadPoolExecutor` immediately, so the paho network loop is never blocked by inference.

---

## 3. Files Created

```
laptop-2/ml_service/
├── config.py          # Environment variable loader
├── predictors.py      # Model loading + predict() function
├── schemas.py         # JSON Schema validation + business rules
├── mqtt_client.py     # Paho-MQTT wrapper (connect, subscribe, publish)
├── main.py            # Entry point, message dispatcher, health logging
├── .env               # User's private credentials (NOT committed)
└── .env.example       # Template with all variable names

laptop-2/tests/
└── test_worker.py     # 16 unit tests (pytest)
```

---

## 4. File-by-File Details

### 4.1 `config.py` — Configuration

Loads environment variables from `.env` using `python-dotenv`. Key variables:

| Variable | Default | Description |
|---|---|---|
| `MQTT_HOST` | *(required)* | Broker hostname or IP |
| `MQTT_PORT` | `1883` | Broker port |
| `MQTT_USERNAME` | *(required)* | MQTT auth username |
| `MQTT_PASSWORD` | *(required)* | MQTT auth password |
| `MQTT_TOPIC_REQUESTS` | `evdt/v1/requests/charging` | Subscribe topic |
| `MQTT_TOPIC_RESULTS_CHARGING` | `evdt/v1/results/charging` | Publish topic |
| `STATION_ID` | `STATION-001` | Station identifier |
| `MODEL_DIR` | `../models` (relative to ml_service/) | Path to joblib models |
| `LOG_LEVEL` | `INFO` | Python logging level |

**Path resolution:** `MODEL_DIR` is resolved relative to `ml_service/` directory (not cwd), so `../models` correctly finds `laptop-2/models/` regardless of where you `cd` from.

### 4.2 `predictors.py` — Model Loading and Inference

**Startup (module import):**
1. Loads `charging_duration.joblib` and `energy.joblib` once
2. Loads `duration_model_metadata.json` and `energy_model_metadata.json`
3. Validates that the metadata's feature lists match the pipeline's `ColumnTransformer` columns
4. If any model or metadata file is missing → `FileNotFoundError` at startup (fail fast)

**Feature mapping (MQTT request → DataFrame):**

The MQTT request JSON has a different structure than the training DataFrame. `_request_to_row()` maps them:

| MQTT Request Field | DataFrame Column | Notes |
|---|---|---|
| `vehicle.batteryCapacityKwh` | `Battery Capacity (kWh)` | Direct |
| `charging.startSocPct` | `State of Charge (Start %)` | Direct |
| `charging.targetSocPct` | `State of Charge (End %)` | Direct |
| `charging.requestedRateKw` | `Charging Rate (kW)` | Direct |
| `environment.temperatureC` | `Temperature (°C)` | Direct |
| `vehicle.vehicleAgeYears` | `Vehicle Age (years)` | Direct |
| *(computed)* | `socDelta` | `targetSocPct - startSocPct` |
| *(computed)* | `requiredEnergyApprox` | `capacity × ΔSOC / 100` (energy model only) |
| *(current time)* | `startHour` | `datetime.now(UTC).hour` |
| *(current time)* | `isWeekend` | `1` if Saturday/Sunday, else `0` |
| `vehicle.model` | `Vehicle Model` | Enum: 5 models |
| `charging.chargerType` | `Charger Type` | Enum: 3 types |
| *(default)* | `Charging Station Location` | Fixed: `"Houston, TX"` |
| *(default)* | `Time of Day` | Fixed: `"Morning"` |
| *(default)* | `User Type` | Fixed: `"Regular"` |

> **Why defaults for Location/TimeOfDay/UserType?** These columns exist in the training data but aren't in the MQTT request (they're not meaningful for real-time inference). The model's one-hot encoder needs *some* valid value. Using the most frequent training value ensures the encoder doesn't error. Because the model has R²≈0 on synthetic data, the specific value doesn't materially affect predictions.

**Output:**
- All predictions are native Python `float` (not `numpy.float64`) — safe for `json.dumps`
- Negative predictions are clamped to 0 with a warning
- Every result includes a warning: *"Predictions are ML estimates from synthetic training data, not physically validated."*

### 4.3 `schemas.py` — Validation

Two-stage validation:

1. **JSON Schema** — Validates against `shared/schemas/charging-request.schema.json` (the same schema from Phase 4). Uses `jsonschema.Draft202012Validator` pre-compiled at module load for speed.

2. **Business rules** — Cross-field constraints the JSON Schema can't express:
   - `targetSocPct > startSocPct` (charging must go up, not down)

**Error reporting:** Raises `schemas.ValidationError` with a machine-readable `code` (`SCHEMA_INVALID` or `BUSINESS_RULE`) and a human-readable `message`. No stack traces leak to MQTT.

### 4.4 `mqtt_client.py` — MQTT Client

Thin wrapper around `paho.mqtt.client`:

| Feature | Implementation |
|---|---|
| **Authentication** | `username_pw_set()` from config |
| **Subscribe on connect** | In `on_connect` callback — auto-resubscribes on reconnect |
| **Reconnect backoff** | `reconnect_delay_set(min=1, max=30)` — paho v2 built-in exponential backoff |
| **Last Will** | Published to `evdt/v1/stations/{stationId}/status` as `{"mlworker":"offline"}` with `retain=True` — broker auto-publishes if worker crashes |
| **QoS** | Subscribe QoS 1, Publish QoS 1 |
| **Client ID** | `mlworker-STATION-001-{random8}` — unique per instance |

### 4.5 `main.py` — Entry Point and Dispatcher

**Message flow:**

1. MQTT callback receives message → immediately submits to `ThreadPoolExecutor(max_workers=2)`
2. Worker thread:
   a. Parse JSON (invalid → `INVALID_JSON` error response)
   b. Dedup by `messageId` (QoS 1 may deliver twice → silently ignore)
   c. Idempotent replay by `requestId` (same requestId → re-publish cached result)
   d. Validate schema + business rules (invalid → `invalid_request` error response)
   e. Run inference via `predictors.predict()`
   f. Cache result by requestId
   g. Publish result to `evdt/v1/results/charging`
3. Exception in any step → `INTERNAL_ERROR` with safe message (no stack trace)

**Deduplication:**
- `_seen_message_ids`: `set[str]` — tracks QoS 1 duplicate deliveries by `messageId`. Capped at 10,000 entries.
- `_seen_request_ids`: `dict[str, str]` — maps `requestId` → cached result JSON. When a retried request arrives (new `messageId`, same `requestId`), the cached result is re-published without re-running inference.

**Health logging:** Every 60 seconds, logs:
```
HEALTH  processed=5  errors=1  duplicates=2  uptime_since=2026-11-17T16:30:00+00:00
```

**Structured request logging:** Every processed request logs:
```
requestId=e2e-req-001  status=completed  latency=42.1ms  duration=2.1737h  energy=38.8176kWh  durationModel=2026-11-17  energyModel=2026-11-17
```

**Graceful shutdown:** Catches `SIGINT`/`SIGTERM`, logs final health metrics, disconnects MQTT, shuts down thread pool.

---

## 5. Unit Tests

**File:** `laptop-2/tests/test_worker.py`

16 tests covering all requirements:

| # | Test | Category | What it verifies |
|---|---|---|---|
| 1 | `test_valid_request_passes` | Schema | Valid request passes validation |
| 2 | `test_missing_vehicle_model_fails` | Schema | Missing required field → `SCHEMA_INVALID` |
| 3 | `test_missing_charging_block_fails` | Schema | Missing required block → `SCHEMA_INVALID` |
| 4 | `test_target_soc_less_than_start_fails` | Business | target < start → `BUSINESS_RULE` |
| 5 | `test_target_soc_equal_to_start_fails` | Business | target = start → `BUSINESS_RULE` |
| 6 | `test_invalid_vehicle_model_fails` | Schema | Unknown vehicle → `SCHEMA_INVALID` |
| 7 | `test_invalid_charger_type_fails` | Schema | Unknown charger → `SCHEMA_INVALID` |
| 8 | `test_valid_prediction_returns_expected_keys` | Predictor | Returns predictions, model, warnings |
| 9 | `test_predictions_are_native_floats` | Predictor | `json.dumps()` succeeds (no numpy types) |
| 10 | `test_valid_request_publishes_completed` | Handler | Valid → `status: completed` with `requestId` |
| 11 | `test_invalid_json_publishes_error` | Handler | Garbage → `INVALID_JSON` error |
| 12 | `test_missing_fields_publishes_invalid_request` | Handler | Missing fields → `SCHEMA_INVALID` |
| 13 | `test_duplicate_message_id_ignored` | Handler | Same `messageId` → silently dropped |
| 14 | `test_duplicate_request_id_republishes_cached` | Handler | Same `requestId` → cached result |
| 15 | `test_business_rule_violation_publishes_error` | Handler | target < start → `BUSINESS_RULE` |
| 16 | `test_model_failure_publishes_safe_error` | Handler | Model exception → `INTERNAL_ERROR`, no stack trace |

**Running tests:**

```bash
cd laptop-2
source .venv/bin/activate
python -m pytest tests/test_worker.py -v
```

**Result:** All 16 passed in 1.19s.

---

## 6. End-to-End Test Results

The broker (Phase 4) and ML worker were started, then 4 test messages were published via `mosquitto_pub` and results captured via `mosquitto_sub`.

### 6.1 Test 1 — Valid prediction request

**Published:**
```json
{
  "schemaVersion": "1.0",
  "messageId": "e2e-msg-001",
  "requestId": "e2e-req-001",
  "sentAt": "2026-11-17T16:30:00.000Z",
  "stationId": "STATION-001",
  "vehicle": {
    "model": "Tesla Model 3",
    "batteryCapacityKwh": 75,
    "vehicleAgeYears": 3
  },
  "charging": {
    "startSocPct": 25,
    "targetSocPct": 80,
    "chargerType": "DC Fast Charger",
    "requestedRateKw": 50
  },
  "environment": {
    "temperatureC": 30,
    "source": "simulation"
  }
}
```

**Received on `evdt/v1/results/charging`:**
```json
{
  "schemaVersion": "1.0",
  "messageId": "6487b02c-5bdc-479b-b4e3-2ef304998ff4",
  "requestId": "e2e-req-001",
  "status": "completed",
  "processedAt": "2026-11-17T16:35:15.878323+00:00",
  "predictions": {
    "durationHours": 2.1737,
    "energyKwh": 38.8176
  },
  "model": {
    "durationVersion": "2026-11-17",
    "energyVersion": "2026-11-17"
  },
  "warnings": [
    "Predictions are ML estimates from synthetic training data, not physically validated."
  ]
}
```

✅ **Passed** — Correlated `requestId`, correct status, predictions present, model versions present.

### 6.2 Test 2 — Invalid JSON payload

**Published:** `{"garbage": true}` (missing all required fields)

**Received:**
```json
{
  "status": "invalid_request",
  "requestId": "unknown",
  "error": {
    "code": "SCHEMA_INVALID",
    "message": "Schema error at '(root)': 'schemaVersion' is a required property"
  }
}
```

✅ **Passed** — Safe error, no stack trace.

### 6.3 Test 3 — Duplicate requestId (idempotent replay)

**Published:** Same `requestId: "e2e-req-001"` as Test 1, but new `messageId: "e2e-msg-003"`.

**Received:** Exact same result as Test 1 (same `processedAt`, same predictions).

✅ **Passed** — Cached result re-published without re-running inference.

### 6.4 Test 4 — Business rule violation

**Published:** `startSocPct: 80`, `targetSocPct: 20` (target < start).

**Received:**
```json
{
  "status": "invalid_request",
  "requestId": "e2e-req-004",
  "error": {
    "code": "BUSINESS_RULE",
    "message": "targetSocPct (20) must be > startSocPct (80)."
  }
}
```

✅ **Passed** — Business rule enforced with clear error.

### 6.5 Worker log output

```
2026-11-17T22:04:57  INFO   ml_worker  ML worker starting — station=STATION-001
2026-11-17T22:04:57  INFO   ml_worker  ML worker ready — waiting for requests on evdt/v1/requests/charging
2026-11-17T22:04:57  INFO   mqtt_client  MQTT connected to 127.0.0.1:1883
2026-11-17T22:04:57  INFO   mqtt_client  Subscribed to evdt/v1/requests/charging (QoS 1)
2026-11-17T22:05:15  INFO   ml_worker  requestId=e2e-req-001  status=completed  latency=42.1ms  duration=2.1737h  energy=38.8176kWh  durationModel=2026-11-17  energyModel=2026-11-17
2026-11-17T22:05:25  WARNING ml_worker  Validation failed for requestId=unknown: Schema error at '(root)': 'schemaVersion' is a required property
2026-11-17T22:05:36  INFO   ml_worker  Re-publishing cached result for requestId=e2e-req-001
2026-11-17T22:05:47  WARNING ml_worker  Validation failed for requestId=e2e-req-004: targetSocPct (20) must be > startSocPct (80).
```

✅ Every request logged with requestId, latency, model version, and outcome.

---

## 7. How to Run

### 7.1 Start the broker (prerequisite)

```bash
cd laptop-2
mosquitto -c mosquitto/mosquitto.conf -d
```

### 7.2 Start the ML worker

```bash
cd laptop-2
source .venv/bin/activate
cd ml_service
python main.py
```

Output:
```
ML worker starting — station=STATION-001
Duration model: .../models/charging_duration.joblib
Energy model:   .../models/energy.joblib
ML worker ready — waiting for requests on evdt/v1/requests/charging
MQTT connected to 127.0.0.1:1883
Subscribed to evdt/v1/requests/charging (QoS 1)
```

### 7.3 Test with mosquitto_pub

```bash
# From another terminal
mosquitto_pub -h 127.0.0.1 -p 1883 -u backend -P backend_pass_2026 \
  -t evdt/v1/requests/charging -q 1 \
  -m '{"schemaVersion":"1.0","messageId":"test-001","requestId":"test-req-001","sentAt":"2026-11-17T10:00:00Z","stationId":"STATION-001","vehicle":{"model":"Tesla Model 3","batteryCapacityKwh":75,"vehicleAgeYears":3},"charging":{"startSocPct":25,"targetSocPct":80,"chargerType":"DC Fast Charger","requestedRateKw":50},"environment":{"temperatureC":30,"source":"simulation"}}'
```

### 7.4 Watch results

```bash
mosquitto_sub -h 127.0.0.1 -p 1883 -u admin -P admin_pass_2026 \
  -t 'evdt/v1/results/charging' -v
```

### 7.5 Stop

```bash
# Stop worker: Ctrl+C (or kill the process)
# Stop broker:
kill $(pgrep -f "mosquitto -c mosquitto/mosquitto.conf")
```

---

## 8. Common Pitfalls Addressed

The implementation plan listed specific pitfalls. Here's how each is handled:

| Pitfall | How Addressed |
|---|---|
| **Fitting encoders at inference** | Models are full sklearn Pipelines (ColumnTransformer + model) saved with joblib. The fitted encoder is baked in. No re-fitting. |
| **Blocking MQTT callback** | `on_message` submits to `ThreadPoolExecutor` immediately. Inference runs in a worker thread. |
| **Model/feature mismatch** | `predictors.py` loads metadata JSON and compares feature lists against the pipeline's `ColumnTransformer` columns at startup. Mismatch → crash with clear error. |
| **NumPy types in JSON** | `predict()` casts all predictions to `float()` before returning. Test `test_predictions_are_native_floats` verifies `json.dumps()` succeeds. |
| **Treating estimates as measurements** | Every result carries a warning: *"Predictions are ML estimates from synthetic training data, not physically validated."* |
| **Stack traces in errors** | All exceptions caught; error responses use generic messages. Test `test_model_failure_publishes_safe_error` verifies no stack trace leaks. |

---

## 9. `.env.example` Updated

**File:** `laptop-2/ml_service/.env.example`

Added `MODEL_DIR` and `LOG_LEVEL` variables to the template.

---

## 10. Acceptance Criteria Checklist

| Criterion | Status |
|---|---|
| One request produces one correlated result | ✅ requestId echoed in result |
| Invalid payload returns a safe error | ✅ SCHEMA_INVALID / BUSINESS_RULE / INVALID_JSON |
| Process reconnects on disconnect | ✅ paho reconnect_delay_set(1, 30) |
| Logs prove latency and model version | ✅ Every request logged with ms latency and model date |
| Duplicate messageId handled | ✅ Silently ignored |
| Duplicate requestId handled | ✅ Cached result re-published |
| Model unavailable → safe error | ✅ INTERNAL_ERROR (no stack trace) |
| No stack traces in MQTT responses | ✅ Verified by unit test |
| Models loaded once at startup | ✅ Module-level singletons |
| Feature names validated at startup | ✅ Metadata vs pipeline comparison |

---

## 11. What's Next — Phase 6

Phase 6 will build the **Node.js/Express backend on Laptop 1:**
- `POST /api/predictions/charging` → validate, generate requestId, publish MQTT, wait up to 15s
- `GET /api/predictions/:requestId` → retrieve persisted result
- Subscribe to MQTT results on startup
- Socket.IO for real-time dashboard updates
- CORS, rate limiting, centralized error handling
