# Connecting Laptop 1, Laptop 2 and the sensor laptop

How to get the machines talking to each other (MQTT, plus OPC UA for the live Arduino temperature) on a shared LAN, and how to check it's actually working.

> **Read this if:** you're setting up the two-laptop demo for the first time, the backend logs show it isn't connected to the broker, or a request on the dashboard gets stuck on "Processing" and then times out.

---

## 1. What runs where

| Machine | Runs | Listens on |
|---|---|---|
| **Laptop 2** | Mosquitto broker, Python ML worker | `1883` (MQTT) |
| **Laptop 1** | Node/Express backend, MongoDB, React frontend | `3000` (API), `5173` (dev frontend) |
| **Sensor laptop** (Windows, Arduino on USB) | OPC UA server for the Arduino temperature (`laptop-sensor`, `npm run opcua:server`) | `4840` (OPC UA) |
| **Laptop 2** (also) | OPC UA → MQTT bridge (`python opcua_bridge/bridge.py`) | — (connects out to the sensor laptop and to its own Mosquitto) |

> With three laptops, the names used in this doc map to yours as: **Sensor laptop** = your Laptop 1 (Windows + Arduino), **Laptop 2** = the Mac, **Laptop 1** here = your Laptop 3 (Windows, frontend + backend). The repo folders keep the old names: `laptop-sensor/` (sensor), `laptop-2/` (Mac), `laptop-1/` (web).

The browser only ever talks to Laptop 1 (`localhost:3000` / `localhost:5173`). Laptop 1's **backend** is the only thing that talks to Laptop 2, over MQTT. The frontend never connects to Laptop 2 directly, and nothing on Laptop 2 talks to MongoDB.

```
Browser --HTTP/WebSocket--> Laptop 1 backend --MQTT--> Laptop 2 (Mosquitto + Python worker)

Arduino --USB--> Sensor laptop (OPC UA server) --OPC UA--> Laptop 2 (bridge) --MQTT--> Laptop 1 backend
```

The live temperature takes the second path. It reaches Laptop 2's ML worker inside a charging request, when the
request uses **Live sensor**. The full design is in [`OPC-UA_implementation-plan.md`](../OPC-UA_implementation-plan.md).

All laptops must be on the **same network** (same Wi-Fi SSID / same router / same LAN), not on separate guest networks or different subnets — MQTT here is plain TCP on the local network, not over the internet.

---

## 2. One-time setup on Laptop 2

### 2.1 Copy the files it needs

Laptop 2 needs:
- `laptop-2/` (the whole folder)
- `shared/schemas/` (the whole folder — the Python worker validates against these)
- `laptop-2/models/*.joblib` — these are **gitignored**, so if you cloned the repo fresh they won't be there. Copy them over separately (USB stick, network share, etc.) from wherever they were trained, or retrain them on Laptop 2 with the Phase 1–3 scripts.

> **Laptop 2 is a Mac in our setup.** The steps below show Windows commands where the original plan assumed Windows; the macOS equivalents are in [§2.6](#26-if-laptop-2-is-a-mac).

### 2.2 Find Laptop 2's LAN IP address

```powershell
ipconfig
```

Look for the **IPv4 Address** under the adapter that's actually connected to the shared network (Wi-Fi or Ethernet) — it'll look like `192.168.x.x` or `10.x.x.x`. Write this down; you'll need it on Laptop 1 in step 3.

> Tip: if your router supports it, give Laptop 2 a fixed/reserved IP (DHCP reservation) so this doesn't change every time it reconnects to Wi-Fi.

### 2.3 Install Python dependencies

```bash
cd laptop-2
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
```

The worker loads trained models from `laptop-2/models/` (`session_duration.joblib`, `session_cost.joblib`,
`battery_life.joblib`). If they are missing, download the data and train them:

```bash
python src/download_datasets.py nasa isu isu-raw paloalto acn
python src/prepare_sessions.py && python src/train_session_models.py
python src/prepare_isu.py && python src/train_battery_degradation.py
python src/prepare_nasa.py && python src/train_battery_soh.py
```

### 2.4 Install Mosquitto (if it isn't already)

Download and install Mosquitto for Windows from the official site, or confirm it's already installed:

```powershell
Get-Service mosquitto -ErrorAction SilentlyContinue
```

If it's running as a Windows service, **stop and disable that service** — you want to run it manually with the project's config instead, otherwise the service's default config (usually no auth, different port behaviour) will fight with what's below.

```powershell
Stop-Service mosquitto -ErrorAction SilentlyContinue
Set-Service mosquitto -StartupType Manual -ErrorAction SilentlyContinue
```

### 2.5 Open the Windows Firewall for MQTT

```powershell
New-NetFirewallRule -DisplayName "Mosquitto MQTT" -Direction Inbound -LocalPort 1883 -Protocol TCP -Action Allow
```

Without this, Laptop 1 will time out trying to connect even though Mosquitto is running correctly.

### 2.6 If Laptop 2 is a Mac

| Step | macOS command |
|---|---|
| Find the Wi-Fi IP | `ipconfig getifaddr en0` |
| Install Mosquitto | `brew install mosquitto` |
| Make sure the Homebrew service isn't also running | `brew services stop mosquitto` |
| Start the broker with the project config | `cd laptop-2 && mosquitto -c mosquitto/mosquitto.conf -v` |
| Python version | Needs **3.11, 3.12 or 3.13** (3.13 trained the models). Check with `python3 --version`; if it's older (macOS's built-in one often is) or 3.14, run `brew install python@3.13` |
| Python venv | `cd laptop-2 && python3.13 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`. If an old `.venv` exists from an earlier phase, delete it first (`rm -rf .venv`) |
| Start the worker | `cd ml_service && cp .env.example .env` (first time only) then `python main.py` |
| Firewall | System Settings → Network → Firewall. If it's on, allow incoming connections for `mosquitto` when macOS asks, or add it with the + button |

What we used in the real two-laptop run (18 Nov 2026): Laptop 2 = Mac at `10.0.247.63`, Laptop 1 = Windows at `10.0.244.114`, same Wi-Fi.

---

## 3. Starting it up (every time)

### 3.1 On Laptop 2 — start Mosquitto

```bash
cd laptop-2
mosquitto -c mosquitto/mosquitto.conf -v
```

This config (`laptop-2/mosquitto/mosquitto.conf`) is already set up to:
- bind to `0.0.0.0:1883` (all network interfaces, so Laptop 1 can reach it — not just `localhost`)
- **require a username and password** (`allow_anonymous false`)
- load the ACL file restricting which user can publish/subscribe to which topic
- log connections and subscriptions to the console (`-v`)

Leave this terminal window open. You should see something like:
```
mosquitto version 2.x starting
Config loaded from mosquitto/mosquitto.conf.
Opening ipv4 listen socket on port 1883.
mosquitto version 2.x running
```

### 3.2 On Laptop 2 — start the Python ML worker (new terminal)

```bash
cd laptop-2/ml_service
copy .env.example .env      # first time only (Mac: cp) — do NOT re-run this later, see §6
python main.py
```

`.env.example` already has the right defaults for this machine (`MQTT_HOST=0.0.0.0`, `MQTT_USERNAME=mlworker`, `MQTT_PASSWORD=mlworker_pass_2026`) since the worker connects to the broker running on the same machine. You should see:
```
ML worker starting — station=STATION-001
Models: duration=palo-alto-hgb-2026-11-18 cost=palo-alto-hgb-2026-11-18 wear=isu-life-1.0  DC price=$0.48/kWh
MQTT connected to 0.0.0.0:1883
Subscribed to evdt/v1/requests/charging (QoS 1)
```

### 3.3 On Laptop 1 — point the backend at Laptop 2

Edit `laptop-1/backend/.env`:

```
MQTT_HOST=<Laptop 2's IP from step 2.2>
MQTT_PORT=1883
MQTT_USERNAME=backend
MQTT_PASSWORD=backend_pass_2026
```

> **Do not** leave this as `127.0.0.1` or the placeholder `192.168.1.50` from `.env.example` — it has to be Laptop 2's **real** IP address from step 2.2.

### 3.4 On Laptop 1 — start the backend and frontend

```bash
cd laptop-1/backend
npm start
```

Check the startup log — this line is the one that matters:
```
{"component":"mqtt","broker":"<Laptop 2's IP>:1883","msg":"connected to broker"}
```
If it instead says `127.0.0.1:1883`, the `.env` edit in 3.3 didn't take — see §6.

```bash
# second terminal
cd laptop-1/frontend
npm run dev
```

Open `http://localhost:5173` in a browser **on Laptop 1**.

### 3.5 Sensor laptop — start the OPC UA server (live Arduino temperature, optional)

Only needed for the live ambient temperature. One-time setup on the sensor laptop:

| Step | Command / action |
|---|---|
| Node.js 20+ | `node -v` |
| Install | `cd laptop-sensor` then `npm install` |
| Settings | `copy .env.example .env` (first time only; defaults are fine) |
| Firewall | PowerShell **as administrator**: `New-NetFirewallRule -DisplayName "EVDT OPC UA 4840" -Direction Inbound -Protocol TCP -LocalPort 4840 -Action Allow -Profile Private`. If Windows asks whether to allow Node.js on first start, allow **Private networks** |
| Fixed IP | Reserve its IP on the router (DHCP reservation), so the Mac's `OPCUA_URL` stays valid |

Every time: plug the Arduino in (sketch `laptop-1/arduino/temperature_lm35/temperature_lm35.ino`), **close the
Arduino IDE Serial Monitor** (only one program can read the COM port), then:

```bash
cd laptop-sensor
npm run opcua:server
```

Expected output:
```
[sensor] OPC UA server running. Security: none, anonymous, read-only (LAN demo).
[sensor] Endpoints for the Mac bridge (OPCUA_URL in laptop-2/opcua_bridge/.env):
[sensor]    opc.tcp://<sensor laptop IP>:4840/evdt
[sensor] serial open: reading COM6 at 9600 baud
[sensor] sensor live (31.26 °C)
[sensor] 31.26 °C  LM35-A0-01  -> OPC UA TemperatureC (Good)
```

The value is updated every 5 s (`SENSOR_PUBLISH_INTERVAL_SEC`). `npm run list-ports` shows the serial ports;
`npm run opcua:server -- --port=COM6` forces one.

### 3.6 Laptop 2 (Mac) — start the OPC UA → MQTT bridge (optional)

One-time setup on the Mac:

| Step | Command |
|---|---|
| Install the OPC UA library | `cd laptop-2 && source .venv/bin/activate && pip install -r requirements.txt` (adds `asyncua==2.1.0`) |
| Settings | `cp opcua_bridge/.env.example opcua_bridge/.env`, then set `OPCUA_URL=opc.tcp://<sensor laptop IP>:4840/evdt` (the URL the sensor laptop prints) |
| Broker user | `opcbridge` is already in `mosquitto/passwd` and `mosquitto/acl`. Restart Mosquitto once after pulling these files |

Every time (new terminal, venv active):

```bash
cd laptop-2
python opcua_bridge/bridge.py
```

Expected output:
```
INFO [opcua_bridge] MQTT connected to 127.0.0.1:1883 as 'opcbridge', publishing to evdt/v1/telemetry/temperature
INFO [opcua_bridge] clock difference with the sensor laptop: 0.0 s (ok)
INFO [opcua_bridge] OPC UA connected to opc.tcp://<sensor IP>:4840/evdt: station STATION-001, sensor LM35-A0-01 (uncalibrated); subscribed to TemperatureC
INFO [opcua_bridge] 31.26 °C  LM35-A0-01  (read 2026-11-18T18:18:02.307Z) -> MQTT evdt/v1/telemetry/temperature
```

Laptop 1 needs nothing new: its backend already subscribes to `evdt/v1/telemetry/temperature`. The **New request**
page then selects **Live sensor** by itself and the temperature follows the board every ~5 s. Start order does not
matter: the bridge keeps retrying until the sensor laptop and the broker are reachable.

---

## 4. Verifying the connection

Do these in order — each one rules out a different link in the chain.

### 4.1 Can Laptop 1 even reach Laptop 2 on the network?

From Laptop 1:
```powershell
ping <Laptop 2's IP>
```
If this fails, it's a network problem (different subnet, firewall, Wi-Fi isolation on a guest network) — nothing MQTT- or app-related will work until this succeeds.

### 4.2 Can Laptop 1 reach Mosquitto specifically?

From Laptop 1 (needs the Mosquitto CLI tools installed, or use the ones under `laptop-2/mosquitto` copied over, or just trust step 4.3 which proves the same thing):
```powershell
Test-NetConnection -ComputerName <Laptop 2's IP> -Port 1883
```
`TcpTestSucceeded : True` means the port is open and something is listening.

### 4.3 Watch raw MQTT traffic

From **either** laptop (needs `mosquitto_sub` — comes with the Mosquitto install):
```bash
mosquitto_sub -h <Laptop 2's IP> -p 1883 -u admin -P admin_pass_2026 -t 'evdt/v1/#' -v
```
This subscribes to every topic as the `admin` user (full read access per the ACL). Leave it running.

### 4.4 Send a real request through the dashboard

On Laptop 1's browser (`http://localhost:5173`):
1. Go to **New request**.
2. Fill in a vehicle, SOC, charger type, submit.
3. Watch the terminal from 4.3 — you should see two lines appear:
   - `evdt/v1/requests/charging` (published by the backend)
   - `evdt/v1/results/charging` (published back by the Python worker, usually under a second later)
4. The dashboard's request detail page should move from **Processing** to **Completed** with duration/energy numbers and an **ML estimate** badge.

### 4.5 Check the backend's own health view

```
GET http://localhost:3000/api/health
```
Look for:
```json
{
  "mqtt": { "connected": true, "broker": "<Laptop 2 IP>:1883" },
  "mlWorker": { "lastResultAt": "<a recent timestamp>" }
}
```
`mqtt.connected: false` means the backend can't reach the broker (back to §4.1–4.2). `mlWorker.lastResultAt` staying `null` after a request means the broker connection is fine but the Python worker isn't running or isn't subscribed.

---

## 5. Credentials reference

Already set up in `laptop-2/mosquitto/passwd` and `laptop-2/mosquitto/acl` — you shouldn't need to change these for the demo, just know what they are:

| Username | Password | Can publish | Can subscribe |
|---|---|---|---|
| `backend` | `backend_pass_2026` | `requests/charging`, `stations/+/status` | `results/*`, `telemetry/*`, `alerts` |
| `mlworker` | `mlworker_pass_2026` | `results/*`, `alerts` | `requests/charging`, `telemetry/*` |
| `sensor` | `sensor_pass_2026` | `telemetry/temperature` | — (used by the temperature simulator) |
| `opcbridge` | `opcbridge_pass_2026` | `telemetry/temperature` | — (the Mac's OPC UA bridge, real Arduino readings) |
| `admin` | `admin_pass_2026` | everything | everything — useful for debugging with `mosquitto_sub`/`mosquitto_pub` |

These are prototype credentials for a trusted LAN demo, not production secrets. Don't expose port 1883 to the public internet with these in place — see the commented-out TLS section in `mosquitto.conf` if you ever need to run this over an untrusted network.

---

## 6. Common problems

| Symptom | Cause | Fix |
|---|---|---|
| Backend log says `MONGODB_URI must start with mongodb://...` | `.env` still has the placeholder from `.env.example` | Edit `laptop-1/backend/.env`, set a real `MONGODB_URI` |
| Backend connects to `127.0.0.1:1883` instead of Laptop 2's IP | `.env` was reset — most often by re-running `copy .env.example .env`, which **overwrites** an already-configured file with no warning | Re-apply your `MQTT_HOST` (and `MONGODB_URI`) edit. Only run `copy .env.example .env` once, the very first time a `.env` doesn't exist yet |
| `ping` to Laptop 2 fails | Laptops are on different networks (e.g. one on a guest Wi-Fi) | Put both on the same SSID/router |
| `ping` works, but MQTT connect times out | Windows Firewall blocking port 1883 on Laptop 2 | Run the firewall rule in step 2.5 |
| Mosquitto starts but closes immediately / wrong behaviour | The Windows Mosquitto **service** is also running and fighting over port 1883 | Stop/disable the service (step 2.4), only run it manually with `-c mosquitto/mosquitto.conf` |
| Backend connects to the broker, but requests never get a result | Python worker isn't running, or crashed loading the models | Check the Python worker's terminal for errors (e.g. missing `.joblib` files — see §2.1) |
| `Connection Refused: not authorised` in Mosquitto's log | Wrong username/password, or a user trying to publish/subscribe a topic the ACL doesn't allow it | Check `.env` on the connecting side matches §5, and that the topic matches the ACL for that user |
| `Test-NetConnection ... -Port 1883` says `True`, but the dashboard header shows **MQTT broker: down** | The network is fine; the broker is **rejecting the login**. We hit this with `MQTT_USERNAME=evdt_user`, a user that doesn't exist in `laptop-2/mosquitto/passwd` | Laptop 1's backend must log in as `backend` / `backend_pass_2026`. Restart the backend after changing `.env` |
| Dashboard shows **"Prediction request not found"** right after switching databases | The browser is on an old request link from the previous database (e.g. local MongoDB). Each database has its own requests | Go to **New request** and send a new one. Old links only work against the database they were created in |
| Atlas works, but there are no charger bays / empty history | `npm run db:setup` was only ever run against the local database | Run `npm run db:setup` in `laptop-1/backend` once with the Atlas `MONGODB_URI` in `.env` |
| Data lands in an Atlas database called `test` | The connection string ends in `...mongodb.net/` with no database name, so MongoDB uses `test` | Put a name after the slash: `...mongodb.net/evdt` |
| Sensor laptop says `COM6 is in use by another program` | The Arduino IDE Serial Monitor or Serial Plotter has the port open | Close that tab. The server retries every 5 s and opens the port by itself |
| Sensor laptop says `an Arduino not found on any serial port` | USB cable unplugged, or a charge-only cable | Plug it in; check `npm run list-ports` in `laptop-sensor` |
| Sensor laptop prints `REJECTED reading ... check the sensor wiring` | The LM35 output wire to A0 is loose (A0 floating reads anything up to ~500 °C) | Re-seat the sensor wires; nothing is served until values make sense |
| Sensor laptop says `could not start the OPC UA server ... EADDRINUSE` | Another copy of the server already runs | Close the other terminal (or Task Manager → node.exe) |
| Bridge says `refused the network connection` / timeout to `opc.tcp://...` | Sensor server not running, wrong IP in `OPCUA_URL`, or the sensor laptop's firewall blocks 4840 | Start it (§3.5); compare `OPCUA_URL` with the URL it prints; add the firewall rule from §3.5. From the Mac: `nc -zv <sensor IP> 4840` |
| Bridge says `MQTT login ... refused` | `opcbridge` missing on the running broker | Pull the latest `mosquitto/passwd` and `acl`, restart Mosquitto |
| Bridge says `clock difference with the sensor laptop is ... s` | The laptops' clocks disagree, so live readings may look old on Laptop 1 | Turn on automatic time sync on all laptops (Windows: Settings → Time & language → Sync now) |
| New request page says **Sensor offline** | No real reading reached Laptop 1 for 30 s (`SENSOR_STALE_SEC`); a `sensor_offline` alert is also on the Alerts page | Check the chain: USB → `npm run opcua:server` (§3.5) → `python opcua_bridge/bridge.py` (§3.6). The alert resolves itself when readings return |
| Request works once, then subsequent ones hang | Python worker crashed after the first message (check its terminal) | Restart `python main.py` on Laptop 2 |

---

## 7. Optional: keeping a copy of all MQTT traffic in Atlas

Mosquitto's own store (`laptop-2/mosquitto/data/mosquitto.db`) can't be moved to MongoDB — Mosquitto only writes its own file format. It stays on the Mac and holds short-lived broker state (retained messages, undelivered QoS 1 messages).

What you *can* do is keep a cloud log of every message that goes over the broker:

```bash
cd laptop-1/backend
npm run archive:mqtt
```

- writes to Atlas database **`mosquitto`**, collection **`messages`** (separate from the backend's `evdt` database)
- only subscribes, never publishes; clean session, so the broker keeps nothing for it while it's off
- retained messages already in `mosquitto.db` are replayed by the broker on first connect and stored with `retained: true`
- duplicates (same topic + `messageId`) are stored once; rows are deleted after `ARCHIVER_TTL_DAYS` (default 7)
- uses `ARCHIVER_MQTT_USERNAME` / `ARCHIVER_MQTT_PASSWORD` from `.env` (`admin`), because the `backend` user isn't allowed to read the request topic

The backend does not need it. Run it in its own terminal only when you want the log.

---

## 8. Shutting down

Order doesn't matter much, but this is the clean sequence:

1. Stop the frontend (`Ctrl+C` in its terminal), the Mac's OPC UA bridge and the sensor laptop's OPC UA server if they run.
2. Stop the backend (`Ctrl+C`) — it publishes a retained "offline" station status and disconnects cleanly.
3. Stop the Python worker on Laptop 2 (`Ctrl+C`) — it publishes a Last Will "offline" message automatically if it's killed instead.
4. Stop Mosquitto on Laptop 2 (`Ctrl+C`).

---

## 9. Related docs

- [`battery_model_limitations.md`](battery_model_limitations.md) — what the SOH/RUL models can and can't claim
- `shared/schemas/TOPIC_MAP.md` — full topic list, QoS, retained-message rules
- `what_I_did/phase4.md` — how the Mosquitto config and message contracts were built
- `what_I_did/phase5.md` — how the Python ML worker was built and tested
- `what_I_did/phase6.md` — how the Laptop 1 backend's MQTT client, timeout and retry logic work
- `what_I_did/phase10_arduino.md` — the live Arduino temperature sensor (backend side)
- `what_I_did/phase12_opcua.md` — the OPC UA path: sensor laptop → Mac bridge → MQTT
