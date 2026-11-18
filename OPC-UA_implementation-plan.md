# OPC UA Implementation Plan — three-laptop version

Status: **implemented (2026-11-18)** with the decisions in §10. Code phases B–E and H are done. Phase G was tested with
all components on one machine (the sensor laptop) against the real Arduino. Phase A (router reservations, firewall rule,
time sync) is network setup to do on the three laptops. Phase F (encryption) was skipped by decision. What was built and
tested: `what_I_did/phase12_opcua.md`.

## 1. Is it possible?

**Yes.** Every link in your description is standard and the project already has most of it:

| Link | Possible? | Already in the project? |
|---|---|---|
| Arduino → Sensor laptop (USB serial) | yes | yes (Phase 10 gateway reads COM6) |
| Sensor laptop → Mac over **OPC UA** | yes | **new** |
| Mac → Mosquitto (MQTT) | yes | broker exists on the Mac |
| Mosquitto → Web laptop backend/frontend | yes | yes (backend subscribes to `evdt/v1/telemetry/temperature`) |
| Web laptop → Mac ML worker → back (MQTT) | yes | yes (Phases 4–6) |

Two points in your description need one clarification, because OPC UA and MQTT each have a "who connects to whom" direction:

1. **"Laptop 1 sends data to Laptop 2 via OPC UA."** In OPC UA the sensor laptop runs an **OPC UA server** (it owns the data). The Mac runs an **OPC UA client** that connects *to* it and subscribes to the value. So the Mac pulls, the sensor laptop does not push. To the user it looks the same.
2. **"Data is sent to Laptop 3."** The Mac's small bridge program publishes each reading to Mosquitto. The Web laptop's backend is already subscribed, so it receives it automatically.

## 2. Names used in this document

Your numbering differs from the folder names in the repo (`laptop-1` = web, `laptop-2` = Mac). To avoid confusion this plan uses **roles**:

| Role | Your number | OS | Repo folder it uses |
|---|---|---|---|
| **Sensor laptop** | Laptop 1 | Windows | new `laptop-sensor/` |
| **Mac** (broker, ML, bridge) | Laptop 2 | macOS | `laptop-2/` (existing + `opcua_bridge/`) |
| **Web laptop** (frontend, backend, MongoDB) | Laptop 3 | Windows | `laptop-1/` (existing, only `.env` changes) |

## 3. Target architecture

```
SENSOR LAPTOP (Windows)                  MAC                                      WEB LAPTOP (Windows)
┌───────────────────────────┐   OPC UA   ┌────────────────────────────────────┐   ┌──────────────────────────┐
│ LM35 → Arduino UNO R4     │  opc.tcp   │ OPC UA client (bridge, Python)     │   │ Browser :5173            │
│   │ USB serial (COM6)     │───4840────>│   validates, converts              │   │   │ HTTP / Socket.IO     │
│   ▼                       │  (client   │   │ MQTT telemetry                 │   │   ▼                      │
│ serial reader             │  connects  │   ▼                                │   │ Express backend :3000    │
│   ▼                       │  to server)│ Mosquitto :1883  ◄────────────────────MQTT─ subscribes telemetry,   │
│ OPC UA SERVER :4840       │            │   ▲   │ requests                   │   │ results; publishes       │
└───────────────────────────┘            │   │   ▼                            │   │ requests                 │
                                         │ Python ML worker ─ results ───────────►│ MongoDB (Atlas/local)    │
                                         └────────────────────────────────────┘   └──────────────────────────┘
```

Message paths:

- **Telemetry:** Arduino → serial → OPC UA server (sensor laptop) → OPC UA client/bridge (Mac) → MQTT `evdt/v1/telemetry/temperature` → backend (web laptop) → MongoDB + Socket.IO → browser.
- **Prediction:** browser → backend → MQTT `requests/charging` → Mac ML worker → MQTT `results/charging` → backend → browser. Unchanged from today.
- When the user sends a request with **Live sensor**, the backend still uses its newest stored sensor reading (see Phase 10). So the live temperature reaches the ML worker inside the request.

## 4. What changes and what does not

**Does not change:** the request/result flow, schemas, the ML worker, the dashboard, the `sensor_offline` alert, "live only if recent and passed checks" rule, database models, the 3D twin.

**Changes:**

| Area | Change |
|---|---|
| Sensor laptop | New small Node package `laptop-sensor/`: serial reader (reused from the Phase 10 gateway) + **OPC UA server**. It no longer talks to MQTT at all |
| Mac | New Python program `laptop-2/opcua_bridge/`: OPC UA client → MQTT publisher. New broker user `opcbridge` |
| Web laptop | Only `.env`: `MQTT_HOST` = Mac's IP. No new code needed for telemetry, because the backend already subscribes to that topic |
| Repo | The `npm run gateway:arduino` script in `laptop-1/backend` is **superseded**. Its serial-reading code moves to `laptop-sensor/`. The "send directly to the backend" idea from earlier is dropped, because the backend is now on a different laptop |

## 5. OPC UA design

### 5.1 Address space (what any OPC UA client sees)

```
Objects
└── EVChargingStation                       (ns=2;s=Station)
    ├── StationId        "STATION-001"
    └── AmbientSensor                       (ns=2;s=AmbientSensor)
        ├── TemperatureC       Double, EngineeringUnits °C   ← the live value
        ├── SensorId           "LM35-A0-01"
        ├── Source             "sensor"
        ├── Quality            "unknown" | "good" | "suspect"
        ├── CalibrationStatus  "uncalibrated" | "calibrated"
        ├── Measures           "ambient / charger-area air, not battery temperature"
        └── SensorState        "live" | "offline" | "none"
```

### 5.2 Value rules (same honesty rules as the rest of the project)

- `TemperatureC` carries a **SourceTimestamp** = the time the reading arrived from the Arduino (the board has no clock).
- Impossible values (outside −50…85 °C) are never written to the node.
- If no valid reading arrives for `SENSOR_STALE_SEC` (30 s), the server sets `TemperatureC`'s OPC UA status to **BadNoCommunication** and `SensorState` to `offline`. It does **not** keep showing the old number as good, and never substitutes a simulated one.
- Only real readings go in this address space. The simulator keeps using MQTT directly and is labelled `simulation`.
- Update interval: the node is updated every `SENSOR_PUBLISH_INTERVAL_SEC` (5 s, the interval you asked for). The sketch still prints every ~2.2 s; the server keeps the newest valid reading and writes it on the 5 s beat.

### 5.3 Technology

| Part | Library | Why |
|---|---|---|
| OPC UA **server** on Windows | `node-opcua` (Node 20+) | Mature, runs on Windows, same language as the existing serial code |
| OPC UA **client** on Mac | `asyncua` (Python) | The Mac already runs Python for the ML worker; no Node needed on the Mac |
| MQTT on the Mac | `paho-mqtt` (already pinned in `laptop-2/requirements.txt`) | Already used by the ML worker |
| Demo viewer (optional) | UaExpert or Prosys OPC UA Browser | Free OPC UA clients to show the node live |

### 5.4 Bridge mapping: OPC UA → existing MQTT telemetry schema

The bridge builds the message already defined in `shared/schemas/telemetry-temperature.schema.json`, so the backend needs no change:

| MQTT field | Comes from |
|---|---|
| `schemaVersion` | `"1.0"` |
| `messageId` | new UUID per message |
| `stationId` | `StationId` node |
| `sensorId` | `SensorId` node |
| `timestamp` | OPC UA **SourceTimestamp** (UTC ISO 8601) |
| `temperatureC` | `TemperatureC` value |
| `source` | `"sensor"` (only if `Source` node says sensor) |
| `calibrationStatus` | `CalibrationStatus` node |
| `simulated` | `false` |

The bridge validates the message against that JSON Schema before publishing (the worker already uses `jsonschema`). It publishes **nothing** when the OPC UA status is bad or the connection is down. The backend's existing monitor then marks the sensor offline after 30 s and raises the `sensor_offline` alert.

### 5.5 Security

| Stage | Setting | When |
|---|---|---|
| Bring-up | SecurityPolicy `None`, anonymous, **read-only** | first tests only, on the LAN |
| Demo | `Basic256Sha256` + `SignAndEncrypt`, self-signed certificates trusted on both sides, username/password | final demo |
| Broker | New MQTT user `opcbridge` that may only **publish** `evdt/v1/telemetry/temperature` (same as today's `sensor` user). Password in the Mac's bridge `.env`, never in git | Phase 4 |

Nothing in the address space is writable. The server rejects all writes.

## 6. Implementation phases

Each phase ends with a check you can see working.

### Phase A — Network, time and prerequisites (no code)
1. Put all three laptops on the **same Wi-Fi/router** (not a guest network).
2. Give the Mac and the sensor laptop **fixed addresses**: set a DHCP reservation on the router, or a static IP. The Mac's IP is used by the web laptop (`MQTT_HOST`) and the sensor laptop's IP is used by the Mac bridge.
3. **Time sync on all three:** the reading's timestamp comes from the sensor laptop's clock, and the web laptop judges "too old" by its own clock. If the clocks differ by more than a few seconds a live sensor can look offline or "ahead of server clock". Windows: Settings → Time & language → Date & time → "Sync now"; macOS syncs automatically (check System Settings → General → Date & Time).
4. Open firewall ports (see §7).
5. **Check:** from the Mac, `nc -zv <sensor-laptop-ip> 4840` later succeeds; from the web laptop, `Test-NetConnection <mac-ip> -Port 1883` succeeds.

### Phase B — Sensor laptop: refactor + 5 s interval
1. Create `laptop-sensor/` with its own `package.json` (so this laptop does not need MongoDB, mongoose, Express, the frontend).
2. Move the serial code (`parseLine`, port detection, reconnect, throttle) from `laptop-1/backend/src/gateway/arduinoGateway.js` into `laptop-sensor/src/`, with its tests. Finish the 5 s publish interval (`SENSOR_PUBLISH_INTERVAL_SEC`).
3. Remove the MQTT publishing from it. Instead it calls an `onReading(reading)` callback that the OPC UA server uses.
4. **Check:** run it; the console prints a valid reading every 5 s.

### Phase C — OPC UA server (sensor laptop)
1. Add `node-opcua`. Build the address space from §5.1.
2. On each reading: write `TemperatureC` with its SourceTimestamp, update `Quality`, `SensorState`.
3. Watchdog: if no valid reading for `SENSOR_STALE_SEC`, set status `BadNoCommunication` and `SensorState = offline`; when readings return, go back to Good automatically.
4. Reject all writes. Listen on `opc.tcp://0.0.0.0:4840/evdt`.
5. `npm run opcua:server`.
6. **Check:** open UaExpert, connect to `opc.tcp://<sensor-ip>:4840/evdt`, drag `TemperatureC` into the data view, and see it change every 5 s. Unplug USB: status turns bad after 30 s.

### Phase D — OPC UA client + MQTT bridge (Mac)
1. Add `asyncua` to `laptop-2/requirements.txt` (pinned version) and install it in the existing `.venv`.
2. New `laptop-2/opcua_bridge/`: connect to the server, **subscribe** to `TemperatureC` (monitored item, 1 s sampling) and read the other nodes.
3. On each data-change notification: skip if status is bad; build and validate the message (§5.4); publish QoS 1 to `evdt/v1/telemetry/temperature` as user `opcbridge`.
4. Reconnect with backoff if the OPC UA server or the broker is unreachable. No queueing of old readings.
5. Add the `opcbridge` user to `laptop-2/mosquitto/passwd` (`mosquitto_passwd -b`) and `acl` (`topic write evdt/v1/telemetry/temperature`), restart Mosquitto.
6. **Check:** `mosquitto_sub -h localhost -u admin -P <pw> -t 'evdt/v1/telemetry/#' -v` shows a reading every ~5 s with `"source":"sensor"`.

### Phase E — Web laptop and end-to-end
1. Set `MQTT_HOST=<mac-ip>` in `laptop-1/backend/.env` (it may already be).
2. Start backend and frontend. Open `http://localhost:5173/requests/new`.
3. **Check:** the sensor box shows **● Live · LM35-A0-01** with the temperature updating every ~5 s; "Live sensor" is selected; submit a request; the detail page shows the temperature, the sensor id and the reading time, and the ML result comes back from the Mac.

### Phase F — Security hardening
1. Generate certificates for the server and the bridge; each side trusts the other's certificate.
2. Switch to `Basic256Sha256` / `SignAndEncrypt` with a username/password. Keep `None` available only behind a config flag for debugging.
3. **Check:** UaExpert cannot connect anonymously; the bridge still works.

### Phase G — Failure tests (must all behave as described)

| Test | Expected |
|---|---|
| Unplug Arduino USB | OPC UA node bad after 30 s → no MQTT publish → web laptop shows **Sensor offline** + `sensor_offline` alert; "Live sensor" refused |
| Replug | Node good → readings resume → alert resolves itself |
| Stop OPC UA server | Bridge logs the loss and retries; same offline result on the web laptop |
| Stop Mosquitto on Mac | Bridge cannot publish (nothing queued); backend shows MQTT down; recovers on restart |
| Wrong clock on one laptop | Reading flagged suspect or offline instead of silently trusted |
| Wire the sensor loosely (reads > 85 °C) | Rejected at the sensor laptop; nothing published |
| Anonymous client after Phase F | Connection refused |

### Phase H — Tests and docs
- Node test: server + OPC UA client read value, timestamp, bad status after silence.
- Python test (`pytest`): bridge with a fake OPC UA server → exact schema-valid MQTT message; no publish on bad status.
- End-to-end script that checks the whole chain with a fake serial port.
- Docs: `what_I_did/phase12_opcua.md`, update `docs/connection.md` and `shared/schemas/TOPIC_MAP.md` (new `opcbridge` user, new data path).
- 5–7 minute demo script (see §9).

## 7. What each laptop needs

### Sensor laptop (Windows) — runs the Arduino and the OPC UA server
| Need | Detail |
|---|---|
| Already there | Arduino IDE, USB driver (COM6 works), Node.js 22 |
| Install | `npm install` in `laptop-sensor/` (brings `serialport`, `node-opcua`) |
| Not needed | MongoDB, Mosquitto, Python, the frontend, the backend |
| Firewall | Allow **inbound TCP 4840** (e.g. `New-NetFirewallRule -DisplayName "OPC UA 4840" -Direction Inbound -Protocol TCP -LocalPort 4840 -Action Allow`) |
| Network | Fixed IP; note it for the Mac's bridge `.env` |
| Run | Close the Arduino IDE Serial Monitor (only one program can use COM6), then `npm run opcua:server` |
| Optional | UaExpert or Prosys OPC UA Browser, to show the node live |

### Mac — broker, ML worker, OPC UA bridge
| Need | Detail |
|---|---|
| Already there | Homebrew, Mosquitto, Python 3.11–3.13 venv with `requirements.txt` (see `docs/connection.md` §2.6) |
| Install | `pip install asyncua==<pinned version>` (added to `laptop-2/requirements.txt`) |
| Config | `laptop-2/opcua_bridge/.env`: `OPCUA_URL=opc.tcp://<sensor-ip>:4840/evdt`, `MQTT_USERNAME=opcbridge`, `MQTT_PASSWORD=...` |
| Broker user | `mosquitto_passwd -b mosquitto/passwd opcbridge <password>` and an ACL entry; restart Mosquitto |
| Firewall | Keep **inbound 1883** allowed for `mosquitto` (System Settings → Network → Firewall). The Mac makes only *outbound* connections to port 4840, so no new inbound rule |
| Stay awake | Run `caffeinate -d` (or turn off sleep) during the demo, otherwise the broker and bridge stop |
| Run (3 terminals) | Mosquitto, `python ml_service/main.py`, `python opcua_bridge/bridge.py` |

### Web laptop (Windows) — frontend, backend, MongoDB
| Need | Detail |
|---|---|
| Already there | Node.js 22, MongoDB (local or Atlas), the repo |
| Install | Nothing new for telemetry |
| Config | `laptop-1/backend/.env`: `MQTT_HOST=<mac-ip>`, `MQTT_USERNAME=backend` (unchanged) |
| Not needed | `serialport`, `node-opcua` (they are only for the sensor laptop) |
| Run | `npm start` in `laptop-1/backend`, `npm run dev` in `laptop-1/frontend` |

### Network checklist
| From | To | Port | Used for |
|---|---|---|---|
| Mac | Sensor laptop | TCP 4840 | OPC UA |
| Sensor laptop | — | — | no connection to MQTT any more |
| Web laptop | Mac | TCP 1883 | MQTT (requests, results, telemetry) |
| Mac bridge, ML worker | Mac itself | TCP 1883 | MQTT (localhost) |

Do not use `localhost` anywhere that crosses a laptop; use the fixed IPs (or hostnames).

## 8. Risks and limits

| Risk | Handling |
|---|---|
| Clock difference between laptops | Time sync in Phase A; flagged "suspect"/offline rather than trusted |
| Wi-Fi drop on any link | Each link reconnects with backoff; the dashboard shows offline instead of stale data |
| Uploading a new sketch while the server runs | Arduino IDE cannot use COM6 while the server holds it: stop the server before uploading |
| OPC UA over Wi-Fi from a laptop that sleeps | Disable sleep on the sensor laptop during the demo |
| `asyncua`/`node-opcua` version differences | Pin exact versions; interoperability tested with UaExpert in Phase C |
| Sensor still measures **ambient** air | Labelled everywhere; never called battery temperature |
| LM35 limits | Uncalibrated, cannot read below about +2 °C |

## 9. Demo flow (5–7 minutes)
1. Show the three laptops and the arrows (this document's diagram).
2. Sensor laptop: UaExpert shows `TemperatureC` updating every 5 s; warm the sensor with a finger.
3. Mac: `mosquitto_sub` shows the same value arriving as MQTT with `"source":"sensor"`.
4. Web laptop: New request page shows **Live sensor** following the value.
5. Submit a request; the result arrives from the Mac with the sensor temperature recorded.
6. Unplug the USB: Sensor offline + alert; replug: it recovers.
7. State limits: ambient air, not battery; uncalibrated; simulated SOC is simulated.

## 10. Decisions (made 2026-11-18)

1. **Security for the demo:** `None` + anonymous, read-only (fastest). Phase F is not done; the endpoint must stay on the trusted LAN.
2. **Direct MQTT gateway as a fallback:** **no.** `npm run gateway:arduino` was removed; the only path for real readings is OPC UA.
3. **Fixed addresses:** router DHCP reservation for the sensor laptop and the Mac.
4. **Update interval:** 5 s, as planned (`SENSOR_PUBLISH_INTERVAL_SEC=5`; `0` would update on every Arduino line).
