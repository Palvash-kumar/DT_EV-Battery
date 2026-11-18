# Phase 6 — Node.js/Express Backend on Laptop 1

Goal of this phase: give the browser one HTTP + WebSocket API on Laptop 1, and keep MQTT entirely inside the backend. The browser never talks to Mosquitto or to Laptop 2 directly.

The backend now:

- accepts a charging prediction request over REST, validates it, saves it as `pending` in MongoDB and publishes it to `evdt/v1/requests/charging` (QoS 1)
- listens on `evdt/v1/results/charging`, checks each result against the shared JSON Schema, ignores duplicates, and updates the right request by `requestId`
- marks a request `timed_out` after 15 s if nothing comes back, and lets it be retried
- pushes every status change to the browser through Socket.IO
- reports its own health (MongoDB, broker, last ML worker result)

---

## 1. Packages

```bash
cd laptop-1/backend
npm install
```

| Package | Why |
|---|---|
| `express` 5 | HTTP API. v5 forwards errors from `async` handlers to the error middleware on its own, so no try/catch in every route |
| `mqtt` 5 | MQTT.js client |
| `mongoose` 8 | MongoDB models |
| `socket.io` 4 | Push updates to the dashboard |
| `zod` 4 | Validate the HTTP body and the `.env` file |
| `ajv` + `ajv-formats` | Validate MQTT payloads against `shared/schemas/*.json` |
| `helmet`, `cors`, `express-rate-limit` | Basic API hardening |
| `pino`, `pino-http` | JSON logs with request ids |
| `aedes` (dev only) | Small in-process MQTT broker for tests |
| `supertest`, `socket.io-client` (dev only) | Integration tests |

I first installed zod 3, but `npm audit` flagged it (high severity, memory exhaustion on large inputs), and the older aedes pulled in a vulnerable `uuid`. Moving to zod 4 and aedes 1.x fixed both: `npm audit` reports 0 vulnerabilities.

Tests use Node's built-in runner (`node --test`), so there is no Jest/Mocha dependency.

---

## 2. Folder layout

```
laptop-1/backend/
├── package.json
├── .env.example            # updated: LOG_LEVEL and rate limits added
├── src/
│   ├── server.js           # entry point, graceful shutdown
│   ├── loadEnv.js          # loads .env before anything else
│   ├── config.js           # env validation (zod) -> typed config
│   ├── runtime.js          # starts MongoDB, MQTT, HTTP, Socket.IO in order
│   ├── app.js              # Express app (middleware + routes)
│   ├── contracts.js        # Ajv validators built from shared/schemas
│   ├── logger.js
│   ├── errors.js
│   ├── middleware/errorHandler.js
│   ├── models/PredictionRequest.js
│   ├── models/Station.js
│   ├── routes/predictions.js
│   ├── routes/stations.js
│   ├── routes/health.js
│   ├── services/mqttClient.js
│   ├── services/predictionService.js
│   ├── services/stationStatusService.js
│   ├── services/realtime.js
│   └── validators/chargingRequest.js
├── scripts/
│   ├── dev-broker.js       # aedes broker, dev only
│   └── stub-worker.js      # fake Laptop 2 worker, dev only
└── test/
    ├── contracts.test.js
    ├── predictions.test.js
    └── helpers.js
```

`runtime.js` is split from `server.js` so the integration tests can start the real backend on a random port with a throwaway database.

---

## 3. How a request flows

```
Browser                 Backend (Laptop 1)                      Mosquitto        ML worker (Laptop 2)
  │ POST /api/predictions/charging
  │──────────────────────▶ zod validation
  │                        save {status: pending}  ──▶ MongoDB
  │                        build envelope (requestId, messageId, sentAt, schemaVersion)
  │                        Ajv check vs charging-request.schema.json
  │                        publish QoS 1 ───────────────────────▶ requests/charging ───▶ predict
  │◀── 202 + Location      start 15 s timer
  │                                                                results/charging ◀─── publish
  │                        Ajv check vs charging-result.schema.json ◀──┘
  │                        drop if messageId already seen
  │                        findOneAndUpdate({requestId, status: pending|timed_out})
  │◀── socket "prediction:update" {status: completed}
```

### 3.1 Request ids

The browser never sends ids. The server creates `requestId` and `messageId` with `crypto.randomUUID()`. A retry keeps the `requestId` and gets a fresh `messageId`, which matches what the Phase 5 worker expects: it re-publishes its cached result for a known `requestId` instead of running the model again.

### 3.2 202 or wait

The plan allowed either waiting up to 15 s or replying `202 Accepted`. I did both:

- default: `202 Accepted`, `Location: /api/predictions/<requestId>`, status `pending`. The dashboard follows it by Socket.IO (polling as fallback).
- `?wait=true`: the HTTP call stays open until the result arrives or the timeout fires. This is just for curl demos.

### 3.3 Correlation and duplicates

Three layers, cheapest first:

1. Ajv schema check. Anything not matching `charging-result.schema.json` is logged and dropped. This also covers the worker's error reply for unparseable input, which uses `requestId: "unknown"`; there is nothing to match that to.
2. An in-memory set of the last 5000 result `messageId`s. A QoS 1 redelivery of the same message is dropped here.
3. The MongoDB update only matches a request whose status is still `pending` or `timed_out`:

   ```js
   PredictionRequest.findOneAndUpdate(
     { requestId: msg.requestId, status: { $in: ['pending', 'timed_out'] } },
     { $set: update },
     { new: true },
   );
   ```

   If two different results for the same request race, only one can match. The second gets `null` and is counted as a duplicate. This works after a restart too, when the in-memory set is empty.

### 3.4 Timeouts, late results, retries

- Every published request gets a `setTimeout` of `REQUEST_TIMEOUT_SEC` (15 s). When it fires, `pending → timed_out` (again guarded by status in the query).
- A result that turns up after the timeout is still saved, with `result.lateResult = true`. Throwing away a valid prediction because it was a bit slow didn't make sense.
- `POST /api/predictions/:id/retry` works for `timed_out` requests and for requests that failed with `BROKER_UNAVAILABLE`. A request the worker rejected (bad input) returns `409 NOT_RETRYABLE`, since it would fail the same way again.
- On startup, `recoverPending()` handles requests left `pending` by a crash: anything older than 15 s becomes `timed_out`, younger ones get a timer for the time left.

### 3.5 Broker down

MQTT.js normally queues QoS 1 messages while offline and sends them on reconnect. For an HTTP request that is the wrong behaviour, because the user would wait with no feedback. `MqttService.publish()` therefore fails straight away if the client is not connected, and also gives up if the broker doesn't acknowledge within 5 s. The request is kept in MongoDB as `failed` with code `BROKER_UNAVAILABLE`, and the API answers `503` including the `requestId` so the UI can offer a retry.

---

## 4. MQTT client details (`services/mqttClient.js`)

| Setting | Value | Reason |
|---|---|---|
| Client id | `backend-STATION-001` | Fixed, so the broker can keep the session |
| `clean` | `false` | Mosquitto (persistence is on in our config) holds QoS 1 results that arrive while the backend restarts |
| Reconnect | 1 s, 2 s, 4s … max 30 s | MQTT.js only has a fixed `reconnectPeriod`, so I double it on each `reconnect` event and reset it on `connect` |
| Last Will | retained `status: "offline"` on `evdt/v1/stations/STATION-001/status` | Valid against `station-status.schema.json` |
| Subscriptions | `results/charging`, `stations/+/status` | Allowed for the `backend` user in the Phase 4 ACL |

One downside of the fixed client id: two backends with the same `STATION_ID` would keep kicking each other off the broker. For one Laptop 1 that is fine.

### The worker's Last Will

The Phase 5 worker sets its will to `{"mlworker":"offline"}` on the same retained station status topic. That payload doesn't follow `station-status.schema.json`, and because it is retained it would replace the real station status. `StationStatusService` handles it:

- it records the time in `mlWorker.lastOfflineNoticeAt` (shown on `/api/health`)
- it re-publishes a schema-valid retained status, so the topic is clean again

Also worth knowing: the Phase 4 ACL does not give `mlworker` write access to `evdt/v1/stations/+/status`, so on the real broker the will may never be delivered. For that reason the backend also tracks `lastResultAt` (time of the last result from the worker), which works no matter what happens to the will.

---

## 5. API

| Method | Path | What it does |
|---|---|---|
| `POST` | `/api/predictions/charging` | Create + publish. `202` (or `200` with `?wait=true` once finished). `400` invalid body, `503` broker down |
| `GET` | `/api/predictions/:requestId` | Current state of one request |
| `POST` | `/api/predictions/:requestId/retry` | Retry a timed-out / broker-failed request |
| `GET` | `/api/stations/:stationId` | Station document |
| `GET` | `/api/health` | Readiness: `200` when MongoDB and MQTT are both connected, otherwise `503` with `status: "degraded"` |
| `GET` | `/api/health/live` | Liveness, always `200` while the process runs |

Request body (the server adds `schemaVersion`, ids and `sentAt`):

```json
{
  "chargerId": "optional",
  "vehicle": { "model": "Tesla Model 3", "batteryCapacityKwh": 75, "vehicleAgeYears": 3 },
  "charging": { "startSocPct": 25, "targetSocPct": 80, "chargerType": "DC Fast Charger", "requestedRateKw": 50 },
  "environment": { "temperatureC": 30, "source": "simulation" }
}
```

The allowed vehicle models, charger types, temperature sources and numeric limits are read from `charging-request.schema.json` at startup (`contracts.js`), so the API can't drift from the contract the Python worker validates against. Before publishing, the full envelope is checked with Ajv as well.

Errors always look like this, and never include a stack trace:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": [{ "path": "charging.targetSocPct", "message": "..." }] } }
```

### Socket.IO

The browser emits `subscribe` with `{ stationId }` and/or `{ requestId }` and joins those rooms. The backend emits:

- `prediction:update` — full request view, to `request:<id>` and `station:<stationId>`
- `service:status` — broker connected/disconnected, to everyone

### Hardening

- CORS allow-list from `CORS_ORIGIN` (comma separated). Other origins get no `Access-Control-Allow-Origin` header.
- `helmet` default headers, `x-powered-by` off.
- JSON body limit 16 KB (`413 PAYLOAD_TOO_LARGE` above that).
- Rate limits per IP: 300/min for the whole API, 30/min for creating/retrying predictions. Health checks are not limited.
- `.env` is validated with zod on startup. A missing `MQTT_HOST` or a bad `MONGODB_URI` stops the process with a list of what is wrong.
- Logs redact `authorization`/`cookie` headers and passwords.

---

## 6. Data saved in this phase

Phase 6 only needs two collections. Phase 7 adds the full data model.

`predictionRequests`

| Field | Notes |
|---|---|
| `requestId` | unique index, `immutable` |
| `stationId`, `chargerId` | |
| `input` | vehicle/charging/environment exactly as sent, `immutable` |
| `status` | `pending` / `completed` / `failed` / `timed_out` |
| `attempts`, `messageIds[]` | one `messageId` per publish |
| `sentAt`, `completedAt`, `timedOutAt` | |
| `result` | predictions, model versions, warnings, `processedAt`, `receivedAt`, `resultMessageId`, `lateResult` |
| `error` | `{ code, message }` |

`stations`: the configured station is upserted on startup.

---

## 7. Bug found in the Phase 4 example

The first test I wrote checks every file in `shared/schemas/examples/` against its schema. It failed straight away:

```
not ok 1 - charging-request example matches its schema
  /environment/source must be equal to one of the allowed values
```

`examples/charging-request.json` had `"source": "simulated"`, but the schema (and the Python worker) only allow `sensor | simulation | manual`. I changed the example to `"simulation"`. The schema stays the same.

---

## 8. Tests

```bash
cd laptop-1/backend
npm test
```

The integration tests need a MongoDB at `mongodb://127.0.0.1:27017` (or `MONGODB_URI_TEST`). Each run creates a database `evdt_test_<random>` and drops it at the end. If no MongoDB is reachable, those tests are skipped instead of failing. The MQTT broker is an aedes instance started inside the test on a random port, and a small fake worker answers requests. It can be switched to answer normally, stay silent, reply with an error, or send the same result twice.

Result:

```
# tests 23
# suites 4
# pass 23
# fail 0
# duration_ms 9206
```

| Test | What it proves |
|---|---|
| shared examples match schemas (3) | Phase 4 examples are valid (after the fix above) |
| worker reply with `requestId: "unknown"` is rejected | uncorrelatable errors are dropped |
| Python timestamp format accepted | `2026-11-17T16:35:15.878323+00:00` passes `date-time` |
| body validator (4) | SOC rule, unknown vehicle, `"simulated"` rejected |
| pending → completed | 202, Location header, result stored, worker got the right envelope |
| `?wait=true` | finished result in one call |
| QoS 1 duplicate ignored | same `messageId` twice → still one document |
| second different result ignored | first result wins |
| timeout + retry | `timed_out`, then retry → new `messageId`, same `requestId`, `completed`, `attempts: 2` |
| late result kept | `timed_out → completed`, `lateResult: true` |
| worker validation error | `failed` with `BUSINESS_RULE`, retry → `409` |
| junk / unknown results dropped | not-JSON, wrong schema, unknown `requestId` |
| Socket.IO | subscribed client sees `pending` then `completed` |
| input errors | field-level `400` |
| bad JSON / 20 KB body / bad id | `400`, `413`, `400`, `404` |
| health + station | `200` with both connections up |
| CORS | allowed origin echoed, other origin not |
| broker down | `503 BROKER_UNAVAILABLE`, request saved as `failed`, `/api/health` → `503 degraded` |

The broker-down test first hung for two minutes. The test broker's `server.close()` waits for open connections, and the backend's connection was still open. Destroying the sockets in the helper fixed it, and it now behaves like a broker process dying.

---

## 9. Running it against the real Python worker

This laptop already has a Mosquitto 2 service on port 1883 (default config, localhost only, no password file). The trained `.joblib` files are gitignored, so to test with the real Phase 5 worker I copied `laptop-2/` to a temp folder, made a venv there and re-ran `prepare_charging_data.py`, `train_duration.py` and `train_energy.py`. Nothing in the repo was overwritten. The selected models came out the same as in Phase 2 (MedianBaseline for duration, LinearBaseline for energy).

Two things came up while doing that:

- `prepare_charging_data.py` needs **pandas 3** (`select_dtypes(include=["object", "str"])` fails on pandas 2.3). This should go into a `requirements.txt` later.
- On Windows the scripts crash at the very end on the `✅` in their print statements (`UnicodeEncodeError`, cp1252 console). The files are already written by then. Setting `PYTHONIOENCODING=utf-8` avoids it.

Then, worker + backend both pointed at `127.0.0.1:1883`:

```bash
curl -s -X POST "localhost:3000/api/predictions/charging?wait=true" \
  -H 'content-type: application/json' \
  -d '{"vehicle":{"model":"Tesla Model 3","batteryCapacityKwh":75,"vehicleAgeYears":3},
       "charging":{"startSocPct":25,"targetSocPct":80,"chargerType":"DC Fast Charger","requestedRateKw":50},
       "environment":{"temperatureC":30,"source":"simulation"}}'
```

```json
{
  "requestId": "4f022b12-ccaf-4621-845a-874a07353955",
  "status": "completed",
  "result": {
    "predictions": { "durationHours": 2.1731, "energyKwh": 38.8551 },
    "model": { "durationVersion": "2026-11-17", "energyVersion": "2026-11-17" },
    "warnings": ["Predictions are ML estimates from synthetic training data, not physically validated."],
    "processedAt": "2026-11-17T17:25:24.682Z",
    "receivedAt": "2026-11-17T17:25:24.689Z",
    "resultMessageId": "35edfb69-6d85-42c3-8285-ce6b58f5916b",
    "lateResult": false
  }
}
HTTP 200 in 0.187s
```

Same `requestId` in both logs:

```
worker   requestId=4f022b12-ccaf-4621-845a-874a07353955  status=completed  latency=35.3ms  duration=2.1731h  energy=38.8551kWh  durationModel=2026-11-17  energyModel=2026-11-17
backend  {"component":"predictions","requestId":"4f022b12-...","messageId":"35edfb69-...","status":"completed","latencyMs":89,"durationModel":"2026-11-17","energyModel":"2026-11-17","late":false,"msg":"result stored"}
```

So the worker took 35 ms, the backend saw the result 89 ms after publishing, and the whole HTTP call took 187 ms.

**Timeout + retry by hand.** With no worker running, a request went `timed_out` exactly 15 s after publishing (`17:19:40 → 17:19:55`). After starting a worker again, `POST /retry` returned `202` and the request completed with `attempts: 2` and two different `messageIds` in MongoDB.

**Worker crash.** I force-killed the Python process. Mosquitto delivered its will straight away and the backend logged:

```
{"level":40,"component":"station-status","topic":"evdt/v1/stations/STATION-001/status","msg":"ML worker last will received"}
```

`/api/health` then showed `"mlWorker":{"lastResultAt":"2026-11-17T17:25:24.685Z","lastOfflineNoticeAt":"2026-11-17T17:25:41.920Z"}`. This local broker has no ACL. With the Phase 4 ACL the will might be blocked (see section 4).

What I could **not** test here: two physical laptops over Wi-Fi, and Mosquitto with our `passwd`/`acl` files. Before the demo, run the curl above from Laptop 1 against Laptop 2's IP.

---

## 10. Dev helpers (Laptop 1 alone)

For working on the frontend without Laptop 2:

```bash
npm run dev:broker        # aedes on 127.0.0.1:1883, no auth (exits with a message if a real Mosquitto already uses the port)
npm run dev:stub-worker   # answers on the real topics
npm run dev:stub-worker -- --drop          # never answers -> shows the timeout path
npm run dev:stub-worker -- --fail-every=3  # every third request fails
```

The stub worker does **not** use the ML models. It computes `energy = capacity × ΔSOC / 0.9` and `duration = energy / min(rate, charger max)`, and every result it sends carries `model.durationVersion = "dev-stub"` and the warning *"Generated by the development stub worker (simple formula), not by the trained ML models."* That way a stub number can't be mistaken for model output on the dashboard.

---

## 11. How to run

```bash
# Laptop 2: Mosquitto + ML worker (Phase 4/5)

# Laptop 1
cd laptop-1/backend
cp .env.example .env          # set MQTT_HOST to Laptop 2's IP and MONGODB_URI
npm install
npm start                     # or: npm run dev  (restarts on file changes)
curl localhost:3000/api/health
```

Variables already set in the shell override `.env`, which is handy for pointing at a local database for a quick test:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017/evdt_dev MQTT_HOST=127.0.0.1 npm start
```

---

## 12. Plan checklist

| From the plan | Done |
|---|---|
| `app.js`, `server.js`, `services/mqttClient.js`, `services/predictionService.js`, routes, models, validators | yes |
| `POST /api/predictions/charging`: validate, UUID, persist pending, QoS 1, wait or 202 | yes, both modes |
| Subscribe to results, validate, deduplicate, atomic update, Socket.IO to the right room | yes |
| `GET /api/predictions/:requestId`, `GET /api/stations/:id`, health | yes, plus `/retry` |
| No browser-to-MQTT | yes, the browser only sees REST + Socket.IO |
| CORS allow-list, rate limit, payload limit, central errors, request logs, env validation | yes |
| Duplicate MQTT result does not create a second prediction | tested |
| Timeout and broker-down errors usable by the UI | `timed_out` + retry, `503` with `requestId` |

## 13. Left for later phases

- `statusHistory` on each request, `source`/`quality` labels, and the other collections → Phase 7
- telemetry, alerts and health results are not subscribed to yet → Phase 7
- the React dashboard → Phase 8
