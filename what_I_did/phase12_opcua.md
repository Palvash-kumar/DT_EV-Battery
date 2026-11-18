# Phase 12 — OPC UA for the live Arduino temperature

Goal: show OPC UA in the project. The Arduino temperature now travels from the sensor laptop to the Mac over
**OPC UA**, then over MQTT to the web laptop as before. Design and decisions: `OPC-UA_implementation-plan.md`.

## 1. Three laptops

| Role (your number) | OS | Runs | Repo folder |
|---|---|---|---|
| Sensor laptop (Laptop 1) | Windows | Arduino on USB + **OPC UA server** | `laptop-sensor/` |
| Mac (Laptop 2) | macOS | Mosquitto, ML worker, **OPC UA → MQTT bridge** | `laptop-2/` |
| Web laptop (Laptop 3) | Windows | backend, frontend, MongoDB | `laptop-1/` |

```
LM35 → Arduino ──USB──> Sensor laptop: OPC UA server  opc.tcp://<ip>:4840/evdt
                                   │ OPC UA (Mac = client, subscription)
                                   ▼
                        Mac: opcua_bridge ──MQTT evdt/v1/telemetry/temperature──> Mosquitto
                                                                                 │
                        Web laptop: backend (checks, MongoDB, Socket.IO) <───────┘ ──> New request page
Charging requests: Web laptop ──MQTT──> Mac ML worker ──MQTT──> Web laptop   (unchanged)
```

## 2. Decisions

| Question | Decision |
|---|---|
| OPC UA security | none, anonymous, **read-only** (LAN demo) |
| Keep the old direct MQTT gateway as fallback | **no**, removed |
| Fixed IPs | router DHCP reservation |
| Update interval | 5 s |

## 3. What was built

### Sensor laptop — `laptop-sensor/` (new Node package)
| File | What it does |
|---|---|
| `src/serial.js` | reads `Temperature: 31.26 °C` lines from the Arduino (moved from the old backend gateway): auto-detects the Arduino by USB id, waits for / re-opens the port, applies the calibration offset, rejects impossible values (outside −50…85 °C) |
| `src/sampler.js` | passes on the **newest** reading once every `SENSOR_PUBLISH_INTERVAL_SEC` (5 s). The reading keeps its arrival time |
| `src/opcuaServer.js` | the OPC UA server (`node-opcua` 2.187.22) |
| `src/main.js` | `npm run opcua:server`; prints the endpoint URL for the Mac |

Address space, namespace `urn:evdt:sensor`:

```
Objects/EVChargingStation           s=Station
  StationId                         s=Station.StationId           "STATION-001"
  AmbientSensor                     s=AmbientSensor
    TemperatureC   Double, °C       s=AmbientSensor.TemperatureC  ← live value
    SensorId                        "LM35-A0-01"
    Source                          "sensor"
    Quality                         "unknown" (uncalibrated) | "good" (calibrated) | "suspect" (outside -30..55 °C)
    CalibrationStatus               "uncalibrated"
    Measures                        "Ambient / charger-area air temperature (not battery temperature)"
    SensorState                     "none" | "live" | "offline"
```

- `TemperatureC` **SourceTimestamp** = when the reading arrived from the Arduino.
- Before the first reading: status `BadWaitingForInitialData`.
- No reading for 30 s, or the USB port closed: status `BadNoCommunication`, `SensorState = offline`. The old value is
  never shown as Good and never replaced by a simulated one.
- All nodes are read-only (writes return `BadNotWritable`).

### Mac — `laptop-2/opcua_bridge/bridge.py` (new)
- `asyncua` 2.1.0 client. It finds the namespace by its URI and **subscribes** to `TemperatureC` with trigger
  `StatusValueTimestamp`, so a repeated temperature with a new timestamp still counts as a new reading.
- For each Good value it builds the existing `telemetry-temperature.schema.json` message (`source: "sensor"`,
  `simulated: false`, `timestamp` = SourceTimestamp), validates it, and publishes QoS 1 as MQTT user `opcbridge`.
- Publishes **nothing** when the status is Bad, the OPC UA link is down, or the broker is down. Readings are not
  queued and replayed later.
- No duplicates after a reconnect: a value not newer than the last one sent is skipped. If the sensor laptop's clock is
  set back by more than 60 s, readings are still published, with a warning.
- Reconnects by itself with backoff 1 → 30 s. At every connect it checks the clock difference with the sensor laptop
  and warns above 5 s.

### Broker — `laptop-2/mosquitto/passwd`, `acl`
New user `opcbridge` / `opcbridge_pass_2026`, allowed **only** to publish `evdt/v1/telemetry/temperature`.

### Web laptop — `laptop-1/`
- No new code for telemetry: the backend already subscribes to the topic and keeps all Phase 10 behaviour (checks,
  `sensorTelemetry`, offline alert, server-side "Live sensor", the form).
- Removed: `npm run gateway:arduino`, `src/gateway/`, the `serialport` dependency and its settings.
- Texts updated: the sensor-offline hint and alert now point to the OPC UA chain.

## 4. What each laptop needs

| Laptop | Install | Config | Firewall / network |
|---|---|---|---|
| Sensor (Windows) | Node 20+, `npm install` in `laptop-sensor` | `copy .env.example .env` | inbound TCP **4840** (rule in `docs/connection.md` §3.5); IP reserved on the router |
| Mac | `pip install -r requirements.txt` (adds `asyncua==2.1.0`) | `cp opcua_bridge/.env.example opcua_bridge/.env`, set `OPCUA_URL`; restart Mosquitto after pulling `passwd`/`acl` | keep 1883 allowed (as before); IP reserved; no sleep during the demo (`caffeinate -d`) |
| Web (Windows) | nothing new | `MQTT_HOST` = Mac's IP (as before) | — |
| All | — | automatic time sync on | same Wi-Fi/router |

## 5. Running it

1. Mac: Mosquitto, ML worker (as before).
2. Sensor laptop: close the Arduino IDE Serial Monitor, then `cd laptop-sensor && npm run opcua:server`. Copy the
   `opc.tcp://…:4840/evdt` URL it prints into the Mac's `opcua_bridge/.env` (first time only).
3. Mac: `cd laptop-2 && source .venv/bin/activate && python opcua_bridge/bridge.py`.
4. Web laptop: backend + frontend as before, then open `/requests/new`. It shows **● Live · LM35-A0-01** with the
   value changing every ~5 s.

Optional demo: any OPC UA client (UaExpert, Prosys OPC UA Browser) can connect to the same URL anonymously and show
`TemperatureC` live.

## 6. Tests

| Suite | Result |
|---|---|
| `laptop-sensor` (`npm test`) | 19 pass: parsing, mock serial port, 5 s sampler, config, and the real OPC UA server checked with a real OPC UA client (identity nodes, Good value + SourceTimestamp, read-only, subscription sees repeated values, BadNoCommunication after silence and recovery) |
| `laptop-2/tests/test_opcua_bridge.py` | 9 pass: settings, schema-valid message, duplicates, Bad status, non-sensor source, broker down, clock set back, and a full run against an in-process OPC UA server including a server restart |
| `laptop-1/backend` | 62 pass (the 9 serial-gateway tests moved to `laptop-sensor`) |
| `laptop-1/frontend` | 33 pass, production build ok |

Mosquitto with the real `passwd`/`acl`: `opcbridge` publishing telemetry was delivered; its publish to
`requests/charging` was dropped by the ACL; a wrong password was refused.

## 7. End-to-end check on the real board (2026-11-18)

Everything ran on the sensor laptop. The bridge connected through the laptop's **LAN IP** (`opc.tcp://10.231.14.168:4840/evdt`)
as the Mac will. The broker was a test Mosquitto with the project's `passwd`/`acl`, and the backend used a throwaway
local database (deleted afterwards).

| Check | Result |
|---|---|
| Sensor server | opened COM6, `TemperatureC` updated every 5 s (30.79…31.14 °C) |
| Bridge | clock difference 0.0 s; one MQTT message per update, ~0.5 s after the OPC UA update |
| Backend | `sensorTelemetry` = 30.94 °C, source `sensor`, age 6 s |
| "Live sensor" request (browser sent 25 °C) | stored 30.92 °C from the sensor, with its timestamp |
| Sensor server stopped | bridge noticed within ~1 s and published nothing; backend `sensor_offline` alert after 33 s; "Live sensor" request refused |
| Sensor server restarted | bridge reconnected by itself; readings resumed; alert resolved ("sensor readings resumed (30.96 °C)") |

**Not tested yet:** the three physical laptops together (the Mac and web laptop were not reachable from here). Things
to watch on the first real run: the Windows firewall rule for 4840 on the sensor laptop, `OPCUA_URL` on the Mac, and
pulling the new `passwd`/`acl` and restarting Mosquitto on the Mac.

## 8. Limitations
- No OPC UA encryption or login (decision). Use only on a trusted LAN; anyone on it can **read** the value, nobody can write.
- Readings are not stored when the OPC UA link or the broker is down.
- The timestamp comes from the sensor laptop's clock: keep time sync on.
- Same sensor limits as Phase 10: ambient air, uncalibrated LM35, nothing below ~+2 °C.
