# Phase 4 — Mosquitto MQTT Broker and Message Contract

> **What this phase is about:** Set up the Mosquitto MQTT broker on Laptop 2, define all MQTT topics with QoS and retained-message policies, create JSON Schemas for every message type, configure password authentication and ACL-based access control, and verify the full pub/sub pipeline with CLI tests. This establishes the two-laptop communication layer that connects Laptop 1 (web app) ↔ Laptop 2 (ML inference).

---

## 1. Mosquitto Installation

Mosquitto was already installed via Homebrew:

```bash
brew install mosquitto
```

| Property | Value |
|---|---|
| Version | 2.1.2 |
| Binary | `/opt/homebrew/sbin/mosquitto` |
| CLI tools | `mosquitto_pub`, `mosquitto_sub`, `mosquitto_passwd` |
| Install method | Homebrew (`brew install mosquitto`) |

---

## 2. Broker Configuration

### 2.1 Configuration file

**File:** `laptop-2/mosquitto/mosquitto.conf`

Key settings:

| Setting | Value | Rationale |
|---|---|---|
| `listener 1883 0.0.0.0` | Listen on all interfaces, port 1883 | Allows Laptop 1 to connect over LAN. NEVER expose to internet without TLS. |
| `allow_anonymous false` | Require authentication | No unauthenticated clients can connect. |
| `password_file` | `mosquitto/passwd` | Hashed passwords (SHA-512). |
| `acl_file` | `mosquitto/acl` | Per-user topic permissions. |
| `max_qos 1` | At-least-once delivery | QoS 1 for all business-critical messages. |
| `message_size_limit 262144` | 256 KB max payload | More than enough for JSON messages. |
| `persistence true` | Persist QoS 1 in-flight messages | Survive broker restarts. |
| `log_type information` | Full structured logging | Timestamps, subscribe/unsubscribe events. |

### 2.2 Starting the broker

```bash
cd laptop-2
mosquitto -c mosquitto/mosquitto.conf          # foreground
mosquitto -c mosquitto/mosquitto.conf -d        # daemonized (background)
```

### 2.3 TLS for untrusted networks

The config file includes commented-out TLS settings. For any network beyond a trusted LAN:

```conf
listener 8883 0.0.0.0
cafile mosquitto/certs/ca.crt
certfile mosquitto/certs/server.crt
keyfile mosquitto/certs/server.key
require_certificate false
tls_version tlsv1.2
```

For this college project on a trusted LAN, plain TCP on port 1883 is sufficient.

---

## 3. Authentication — Users and Passwords

### 3.1 Users created

| Username | Role | Password (prototype) |
|---|---|---|
| `backend` | Laptop 1 Node.js/Express API | `backend_pass_2026` |
| `mlworker` | Laptop 2 Python ML inference service | `mlworker_pass_2026` |
| `sensor` | Arduino temperature gateway | `sensor_pass_2026` |
| `admin` | Development/debugging (full access) | `admin_pass_2026` |

> **Note:** These are prototype passwords stored in `.env` files. For production, use strong random passwords and never commit them to Git. The `.env.example` files document the variable names.

### 3.2 Password file

**File:** `laptop-2/mosquitto/passwd`

Passwords are hashed with SHA-512 by `mosquitto_passwd`:

```bash
mosquitto_passwd -b mosquitto/passwd backend backend_pass_2026
mosquitto_passwd -b mosquitto/passwd mlworker mlworker_pass_2026
mosquitto_passwd -b mosquitto/passwd sensor sensor_pass_2026
mosquitto_passwd -b mosquitto/passwd admin admin_pass_2026
chmod 0700 mosquitto/passwd
```

The file contains only hashed entries — no plaintext passwords.

---

## 4. Access Control List (ACL)

**File:** `laptop-2/mosquitto/acl`

The ACL restricts which user can publish/subscribe to which topics:

| User | Can Publish | Can Subscribe |
|---|---|---|
| `backend` | `requests/charging`, `stations/+/status` | `results/*`, `telemetry/*`, `alerts`, `stations/+/status` |
| `mlworker` | `results/charging`, `results/health`, `results/optimization`, `alerts` | `requests/charging`, `telemetry/*` |
| `sensor` | `telemetry/temperature` | *(nothing)* |
| `admin` | `evdt/v1/#` (everything) | `evdt/v1/#` (everything) |

**Key design:** The browser (React frontend) NEVER connects directly to MQTT. Only the backend server manages MQTT. This prevents exposing broker credentials to the browser.

---

## 5. Topic Map

All topics use the prefix `evdt/v1/` for forward compatibility.

```
evdt/v1/
├── requests/
│   └── charging              → Laptop 1 publishes prediction requests
├── results/
│   ├── charging              → Laptop 2 publishes duration/energy predictions
│   ├── health                → Laptop 2 publishes SOH/RUL estimates
│   └── optimization          → Laptop 2 publishes smart-charging plans (Phase 11)
├── telemetry/
│   └── temperature           → Arduino gateway publishes ambient temp readings
├── alerts                    → Any service publishes anomalies/faults
└── stations/
    └── {stationId}/
        └── status            → Backend publishes latest station state (retained)
```

| Topic | QoS | Retain | Purpose |
|---|---|---|---|
| `evdt/v1/requests/charging` | 1 | No | Duration/energy prediction request |
| `evdt/v1/results/charging` | 1 | No | Correlated prediction result |
| `evdt/v1/results/health` | 1 | No | SOH/RUL estimate |
| `evdt/v1/results/optimization` | 1 | No | Smart-charging plan (Phase 11) |
| `evdt/v1/telemetry/temperature` | 1 | No | Sensor reading |
| `evdt/v1/alerts` | 1 | No | Anomalies/maintenance |
| `evdt/v1/stations/{id}/status` | 1 | **Yes** | Latest station state |

**QoS 1 rationale:** At-least-once delivery — guarantees messages aren't lost during brief network interruptions. Trade-off: may deliver duplicates, so all consumers must deduplicate by `messageId`.

**Retained messages:** Only `stations/{id}/status` uses `retain=true` — new subscribers immediately get the latest state. One-time requests and results are NEVER retained.

---

## 6. JSON Schemas

Six JSON Schemas were created in `shared/schemas/`:

| Schema File | Topic | Purpose |
|---|---|---|
| `charging-request.schema.json` | `evdt/v1/requests/charging` | Validates prediction request payloads |
| `charging-result.schema.json` | `evdt/v1/results/charging` | Validates prediction result payloads |
| `health-result.schema.json` | `evdt/v1/results/health` | Validates SOH/RUL result payloads |
| `telemetry-temperature.schema.json` | `evdt/v1/telemetry/temperature` | Validates temperature readings |
| `alert.schema.json` | `evdt/v1/alerts` | Validates alert payloads |
| `station-status.schema.json` | `evdt/v1/stations/{id}/status` | Validates station status payloads |

### 6.1 Key schema design decisions

**All messages include:**
- `schemaVersion: "1.0"` — for forward compatibility
- `messageId` (UUID) — unique per MQTT publish, used for QoS 1 deduplication
- Timestamps in UTC ISO 8601 format

**Request/result correlation:**
- `requestId` (UUID) — same across retries; correlates the request to its result
- Backend generates `requestId` when user submits; ML worker echoes it in the result

**Source labeling:**
- Temperature readings carry `source: "sensor" | "simulation"`
- SOH/RUL results carry `applicabilityNotes` documenting chemistry/domain limitations
- Station status carries `temperatureSource: "sensor" | "simulation" | "unknown"`

### 6.2 Charging Request Schema (key fields)

```json
{
  "vehicle": {
    "model": "Tesla Model 3",           // enum: 5 models from training data
    "batteryCapacityKwh": 75,           // > 0, ≤ 300
    "vehicleAgeYears": 3               // ≥ 0, ≤ 30
  },
  "charging": {
    "startSocPct": 25,                  // 0–100
    "targetSocPct": 80,                 // 0–100, must be > startSocPct
    "chargerType": "DC Fast Charger",   // enum: 3 types from training data
    "requestedRateKw": 50              // > 0, ≤ 350
  },
  "environment": {
    "temperatureC": 30,                // -50 to 60
    "source": "simulated"              // enum: sensor/simulation/manual
  }
}
```

### 6.3 Charging Result Schema (key fields)

```json
{
  "status": "completed",               // completed | error | invalid_request
  "predictions": {
    "durationHours": 2.28,             // ML estimate, not measured
    "energyKwh": 37.62                 // ML estimate, not measured
  },
  "model": {
    "durationVersion": "2026-11-17",   // training date for auditability
    "energyVersion": "2026-11-17"
  },
  "warnings": ["..."]                  // human-readable caveats
}
```

---

## 7. Example Messages

Three example JSON messages are provided in `shared/schemas/examples/`:

| File | Description |
|---|---|
| `charging-request.json` | A complete prediction request for a Tesla Model 3, 25→80% SOC, DC Fast Charger |
| `charging-result.json` | The correlated result with duration and energy predictions |
| `health-result.json` | A SOH/RUL estimate with applicability notes |

These serve as test fixtures and documentation for developers.

---

## 8. ID Conventions and Timeout Behavior

### 8.1 ID conventions

| ID | Purpose | Generated By | Lifetime |
|---|---|---|---|
| `messageId` | Unique per MQTT publish | Publisher (UUID v4) | Single message |
| `requestId` | Logical request identifier | Backend (UUID v4) | Request lifecycle (same across retries) |
| `alertId` | Alert lifecycle tracking | Alert source (UUID v4) | Alert lifecycle (open → ack → resolved) |

### 8.2 Timeout flow

1. Backend publishes request with `requestId` and starts a **15-second timer**
2. If result arrives within 15 seconds → update status to `completed`
3. If timer expires → update status to `timed_out`, persist for possible retry
4. On intentional retry: new `messageId`, same `requestId`
5. ML worker: if `requestId` already processed, re-publish cached result (idempotent)

### 8.3 QoS 1 duplicate handling

QoS 1 may deliver the same message twice. All consumers must:
- Track seen `messageId` values (in-memory set or database)
- Silently ignore messages with a previously seen `messageId`
- Process only the first occurrence

---

## 9. Test Results

All tests were run with the broker running locally. All passed.

| Test | Command | Result |
|---|---|---|
| **1. Pub/sub request** | `backend` publishes to `requests/charging` | ✅ Received by `admin` subscriber |
| **2. Pub/sub result** | `mlworker` publishes to `results/charging` | ✅ Received by `admin` subscriber |
| **3. requestId correlation** | Request and result share `requestId: test-req-001` | ✅ Correlated |
| **4. ACL deny** | `sensor` publishes to `requests/charging` | ✅ Silently dropped (ACL) |
| **5. ACL allow** | `sensor` publishes to `telemetry/temperature` | ✅ Published OK |
| **6. Wrong password** | `backend` with wrong password | ✅ "Connection Refused: not authorised" |
| **7. Anonymous** | No username/password | ✅ "Connection Refused: not authorised" |
| **8. Retained publish** | `backend` publishes station status with `-r` | ✅ Published OK |
| **9. Retained delivery** | New subscriber to `stations/+/status` | ✅ Immediately receives latest status |

### 9.1 Test commands used

```bash
# Start the broker
cd laptop-2
mosquitto -c mosquitto/mosquitto.conf -d

# Subscribe to all topics (admin — full access)
mosquitto_sub -h 127.0.0.1 -p 1883 -u admin -P admin_pass_2026 -t 'evdt/v1/#' -v

# Publish a prediction request (backend user)
mosquitto_pub -h 127.0.0.1 -p 1883 -u backend -P backend_pass_2026 \
  -t evdt/v1/requests/charging -q 1 \
  -m '{"schemaVersion":"1.0","messageId":"test-001","requestId":"req-001","sentAt":"2026-11-17T10:00:00Z","stationId":"STATION-001","vehicle":{"model":"Tesla Model 3","batteryCapacityKwh":75,"vehicleAgeYears":3},"charging":{"startSocPct":25,"targetSocPct":80,"chargerType":"DC Fast Charger","requestedRateKw":50},"environment":{"temperatureC":30,"source":"simulated"}}'

# Publish a prediction result (mlworker user)
mosquitto_pub -h 127.0.0.1 -p 1883 -u mlworker -P mlworker_pass_2026 \
  -t evdt/v1/results/charging -q 1 \
  -m '{"schemaVersion":"1.0","messageId":"test-002","requestId":"req-001","status":"completed","processedAt":"2026-11-17T10:00:01Z","predictions":{"durationHours":2.28,"energyKwh":37.62},"model":{"durationVersion":"2026-11-17","energyVersion":"2026-11-17"},"warnings":[]}'

# Test auth failure (wrong password)
mosquitto_pub -h 127.0.0.1 -p 1883 -u backend -P wrong_password \
  -t evdt/v1/test -m '{"test":"auth"}'
# → "Connection Refused: not authorised"

# Stop the broker
kill $(pgrep -f "mosquitto -c mosquitto/mosquitto.conf")
```

---

## 10. .env.example Files Updated

Both laptops' `.env.example` files were updated with MQTT topic variables:

**Laptop 1 (`laptop-1/backend/.env.example`):**
- `MQTT_HOST=192.168.1.50` (Laptop 2's LAN IP)
- `MQTT_USERNAME=backend`
- All topic names as environment variables

**Laptop 2 (`laptop-2/ml_service/.env.example`):**
- `MQTT_HOST=0.0.0.0` (local broker)
- `MQTT_USERNAME=mlworker`
- All topic names as environment variables

---

## 11. How to Run the Broker

```bash
# Start
cd laptop-2
mosquitto -c mosquitto/mosquitto.conf -d

# Verify it's running
ps aux | grep mosquitto

# Monitor all traffic (admin user)
mosquitto_sub -h 127.0.0.1 -p 1883 -u admin -P admin_pass_2026 -t 'evdt/v1/#' -v

# Stop
kill $(pgrep -f "mosquitto -c mosquitto/mosquitto.conf")
```

For the two-laptop demo:
1. Ensure Laptop 2 has a known LAN IP (e.g., `192.168.1.50`)
2. Start the broker on Laptop 2
3. Update Laptop 1's `.env` with `MQTT_HOST=192.168.1.50`
4. Both laptops' services connect to the same broker

---

## 12. Files Created in This Phase

```
# Mosquitto configuration
laptop-2/mosquitto/mosquitto.conf               # Broker config
laptop-2/mosquitto/passwd                        # Hashed password file (chmod 0700)
laptop-2/mosquitto/acl                           # Access control list
laptop-2/mosquitto/data/                         # Persistence directory

# JSON Schemas (6 files)
shared/schemas/charging-request.schema.json
shared/schemas/charging-result.schema.json
shared/schemas/health-result.schema.json
shared/schemas/telemetry-temperature.schema.json
shared/schemas/alert.schema.json
shared/schemas/station-status.schema.json

# Example messages (3 files)
shared/schemas/examples/charging-request.json
shared/schemas/examples/charging-result.json
shared/schemas/examples/health-result.json

# Topic documentation
shared/schemas/TOPIC_MAP.md

# Updated .env.example files
laptop-1/backend/.env.example
laptop-2/ml_service/.env.example
```

---

## 13. What's Next — Phase 5

Phase 5 will build the **Python MQTT inference worker** on Laptop 2:
- Load the trained model pipelines (from Phase 2 and 3) once at startup
- Subscribe to `evdt/v1/requests/charging`
- Validate incoming requests against the JSON Schema
- Run duration and energy predictions off the MQTT callback thread
- Publish correlated results to `evdt/v1/results/charging` with the original `requestId`
- Handle reconnection with exponential backoff
