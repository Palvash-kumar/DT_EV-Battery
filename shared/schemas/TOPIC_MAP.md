# MQTT Topic Map & Message Contract

## Broker Details

| Property | Value |
|---|---|
| Host | Laptop 2 LAN IP (e.g., `192.168.1.50`) |
| Port | 1883 (plain TCP, trusted LAN only) |
| TLS Port | 8883 (uncomment in mosquitto.conf for untrusted networks) |
| Protocol | MQTT v3.1.1 / v5 |
| Auth | Username/password (hashed, non-anonymous) |
| Max payload | 256 KB |

## Topic Structure

All topics use the prefix `evdt/v1/` for versioning.

```
evdt/v1/
├── requests/
│   └── charging              # Laptop 1 → Laptop 2 (prediction request)
├── results/
│   ├── charging              # Laptop 2 → Laptop 1 (duration/energy result)
│   ├── health                # Laptop 2 → Laptop 1 (SOH/RUL estimate)
│   └── optimization          # Laptop 2 → Laptop 1 (smart-charging plan)
├── telemetry/
│   └── temperature           # Mac OPC UA bridge (real Arduino) or simulator → both (ambient temp reading)
├── alerts                    # Any service → Laptop 1 (anomalies/faults)
└── stations/
    └── {stationId}/
        └── status            # Backend → clients (retained, latest state)
```

## Topic Details

| Topic | QoS | Retain | Publisher | Subscriber | Schema |
|---|---|---|---|---|---|
| `evdt/v1/requests/charging` | 1 | No | backend | mlworker | `charging-request.schema.json` |
| `evdt/v1/results/charging` | 1 | No | mlworker | backend | `charging-result.schema.json` |
| `evdt/v1/results/health` | 1 | No | mlworker | backend | `health-result.schema.json` |
| `evdt/v1/results/optimization` | 1 | No | mlworker | backend | *(Phase 11)* |
| `evdt/v1/telemetry/temperature` | 1 | No | opcbridge (real sensor), sensor (simulator) | backend, mlworker | `telemetry-temperature.schema.json` |
| `evdt/v1/alerts` | 1 | No | mlworker | backend | `alert.schema.json` |
| `evdt/v1/stations/{id}/status` | 1 | **Yes** | backend | clients | `station-status.schema.json` |

## QoS Rationale

**QoS 1 (at-least-once)** for all business-critical messages because:
- Guarantees delivery even after brief network interruptions
- Trade-off: may deliver duplicates → all consumers **must** deduplicate by `messageId`
- QoS 0 risks losing predictions; QoS 2 adds latency and complexity

## Retained Messages

Only `stations/{id}/status` uses `retain=true`:
- New subscribers immediately get the latest station state
- One-time requests/results must NEVER be retained (would replay stale data)

## ID Conventions

| ID | Purpose | Lifetime |
|---|---|---|
| `messageId` | Unique per MQTT publish. Used for QoS 1 deduplication. | Single message |
| `requestId` | Logical request. Same across retries. Correlates request → result. | Request lifecycle |
| `alertId` | Stable alert. Used for lifecycle tracking (open → ack → resolved). | Alert lifecycle |
| `stationId` | Station identifier. | Permanent |

## Timeout Behavior

1. Backend publishes request with `requestId` and starts a 15-second timer
2. If result arrives within 15s → status = `completed`
3. If timer expires → status = `timed_out`, persisted for retry
4. Retry uses a **new** `messageId` but the **same** `requestId`
5. ML worker deduplicates by `requestId` — if already processed, re-publishes cached result

## Users & Permissions

| Username | Role | Can Publish | Can Subscribe |
|---|---|---|---|
| `backend` | Laptop 1 Express API | `requests/charging`, `stations/+/status` | `results/*`, `telemetry/*`, `alerts` |
| `mlworker` | Laptop 2 Python worker | `results/*`, `alerts` | `requests/charging`, `telemetry/*` |
| `sensor` | Temperature simulator (`npm run dev:sim-telemetry`) | `telemetry/temperature` | *(none)* |
| `opcbridge` | Mac OPC UA → MQTT bridge (`laptop-2/opcua_bridge`) for the real Arduino sensor | `telemetry/temperature` | *(none)* |
| `admin` | Development/debug | `evdt/v1/#` | `evdt/v1/#` |
