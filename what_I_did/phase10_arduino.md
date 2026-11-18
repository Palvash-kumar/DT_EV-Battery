# Phase 10 — Live Arduino temperature sensor

Goal (Implementation plan, Phase 10): one real telemetry channel. The ambient temperature from an Arduino UNO R4 WiFi
reaches the dashboard live, labelled **Live sensor**. On the **New request** page (`/requests/new`) the
**Environment** temperature now comes from the board automatically.

(`phase10.md` in this folder covers the dataset retraining done before this.)

---

## 1. Hardware

| Item | Value |
|---|---|
| Board | Arduino UNO R4 WiFi, USB to the laptop (COM6 on this machine, USB id `2341:1002`) |
| Sensor | LM35 analog, 10 mV/°C, output on **A0**, powered from 5 V |
| Sketch | `laptop-1/arduino/temperature_lm35/temperature_lm35.ino`: 20 samples averaged, 12-bit ADC, prints `Temperature: 31.26 °C` every ~2.2 s at 9600 baud |
| Measures | **ambient / charger-area air temperature**, never battery-cell temperature |
| Calibration | none, so readings are stored as `uncalibrated` and the dashboard shows "Unverified" |

No high-voltage or EV connection is involved. The board is only on USB.

## 2. Why a serial gateway (not Wi-Fi MQTT from the board)

The R4 WiFi could do MQTT itself, but it would need Wi-Fi credentials and broker passwords stored on the board, and
the broker IP changes with the network. The plan says to use a small serial gateway when that is simpler. The sketch
already printed readings over USB, so it needed **no change and no re-upload**.

```
LM35 -> Arduino A0 -> USB serial (COM6) -> arduino-gateway.js -> MQTT evdt/v1/telemetry/temperature
     -> backend (checks, stores, Socket.IO) -> New request form / Overview / Telemetry / 3D twin
```

## 3. What was built

| Part | File | What it does |
|---|---|---|
| Gateway | `laptop-1/backend/src/gateway/arduinoGateway.js`, `scripts/arduino-gateway.js` (`npm run gateway:arduino`) | finds the Arduino by USB vendor id, reads lines, rejects impossible values (outside −50…85 °C: loose wire), stamps the arrival time, validates against `telemetry-temperature.schema.json`, publishes QoS 1 as user `sensor` with `source: "sensor"`, `simulated: false`. Re-opens the port after unplug/replug. Does not queue readings while the broker is down, so stale values are never replayed as if live |
| Rate check | `services/ingestService.js` | a reading that changes more than 1 °C/s compared with the last reading that passed its checks is stored as **suspect** |
| Health rule | `domain/sensorHealth.js` (and a copy in `frontend/src/lib/sensorHealth.js`) | `live` / `suspect` / `offline` (no reading for `SENSOR_STALE_SEC` = 30 s) / `none` |
| Sensor monitor | `services/sensorMonitor.js` | opens one `sensor_offline` alert when readings stop, and resolves it when they come back. It never fills the gap with simulated values |
| Request check | `services/predictionService.js` | for `environment.source = "sensor"` the **server** takes the temperature from the newest stored sensor reading (it ignores the number the browser sent). The request is refused with `409 SENSOR_NOT_LIVE` if that reading is offline or suspect. The stored request keeps `sensorReading` (messageId, sensorId, timestamp), so every request can be traced to the exact reading |
| Station view | `services/stationService.js` | new `sensorTelemetry` = newest **real** reading, kept separate so a running simulator can never hide it or stand in for it |
| Form | `pages/NewRequest.jsx`, `components/SensorStatus.jsx` | sensor status box (Live / Suspect / Offline / No data, with sensor id, value and age, ticking every second). Selects **Live sensor** by itself when the board is live. The temperature field is read-only and follows every new reading. Manual and Simulated are still available and stay labelled as such |
| Request detail | `pages/RequestDetail.jsx` | shows which sensor and which reading time were used |

## 4. Settings (`laptop-1/backend/.env`, documented in `.env.example`)

```
SENSOR_STALE_SEC=30          # older than this = offline
ARDUINO_SERIAL_PORT=auto     # or COM6
ARDUINO_BAUD=9600
SENSOR_ID=LM35-A0-01
SENSOR_CALIBRATION=uncalibrated
SENSOR_OFFSET_C=0            # one-point calibration
SENSOR_MQTT_USERNAME=sensor
SENSOR_MQTT_PASSWORD=sensor_pass_2026
```

One-point calibration: put a reference thermometer next to the LM35 and wait 10 minutes. Set
`SENSOR_OFFSET_C = reference − LM35 reading` and `SENSOR_CALIBRATION=calibrated`, then restart the gateway. Readings
then get quality "good" instead of "unverified".

## 5. Running it

1. Start Mosquitto and the ML worker (Laptop 2), then the backend and frontend (Laptop 1), as in `docs/connection.md`.
2. **Close the Arduino IDE Serial Monitor.** Windows lets only one program open COM6.
3. `cd laptop-1/backend && npm run gateway:arduino`
4. Open `http://localhost:5173/requests/new`. The Environment box shows **● Live · LM35-A0-01 · 31.26 °C · read 1 s ago**
   and "Temperature comes from" is **Live sensor (latest Arduino reading)**.

## 6. Checked on the real board (2026-11-18)

Backend on the local broker and a throwaway local database (`evdt_phase10_check`, dropped afterwards):

| Check | Result |
|---|---|
| Gateway with Serial Monitor open | "COM6 is in use by another program. Close the Arduino IDE Serial Monitor…", retried every 5 s, opened by itself once it was closed |
| Live readings | 31.18 … 31.36 °C every ~2.2 s, `source: sensor`, quality `unknown` (uncalibrated) |
| Request with source sensor, browser sent 25 °C | stored `temperatureC: 31.36, source: sensor`, linked to that reading's messageId |
| Gateway stopped | after 33 s: `sensor_offline` warning alert for `LM35-A0-01`; a sensor request was refused with `SENSOR_NOT_LIVE` |
| Gateway restarted | alert resolved by itself: "sensor readings resumed (31.24 °C)" |

## 7. Tests

- Backend: 71 (53 before + 18 new in `test/sensor.test.js`). They cover line parsing (including a cut-off first line
  and impossible values), the schema, port auto-detect, waiting for a port to appear, no publish while the broker is
  down (all with a mock serial port), the rate check, the health rule, and the server-side sensor request: no reading,
  simulated reading, stored value wins, suspect, old reading, and one alert raised then resolved.
- Frontend: 33 (27 + 6 in `test/sensor.test.jsx`). Live sensor selected automatically, field follows new readings, a
  simulated reading is never offered as the sensor, an old reading shows offline. The production build passes.

## 8. Limitations

- LM35 with this wiring cannot read below about +2 °C, and it is uncalibrated (±0.5–1 °C typical).
- If the signal wire is pulled to ground, the board reads a steady 0 °C. The first jump is flagged suspect, but a
  steady wrong value after a minute is not detectable by software.
- The timestamp is when the reading reached the laptop. The board has no clock (delay < 1 s).
- Readings during a broker outage are not stored.
