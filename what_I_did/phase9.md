# Phase 9 — Three.js Digital Twin

Goal of this phase: an interactive 3D model of the charging station that shows the **actual application state**, not a looping animation. It reads the same backend data as the dashboard table, changes when the backend changes, and only moves things that have a data source behind them.

New page: **Station twin (3D)** at `/twin`, also linked from the Overview ("Open 3D view").

Screenshots are in `what_I_did/screenshots/phase9/`.

---

## 1. Packages

```bash
cd laptop-1/frontend
npm install three@0.187 @react-three/fiber@9 @react-three/drei@10
```

| Package | Why |
|---|---|
| `three` 0.187 | 3D engine |
| `@react-three/fiber` 9 | three.js as React components |
| `@react-three/drei` 10 | only `OrbitControls` is used (rotate/zoom the camera) |

React Three Fiber 9 supports React `>=19 <19.4`, so I changed `react` and `react-dom` from `^19.3.1` to `~19.3.1` in `package.json`. Otherwise a fresh `npm install` could pull in 19.4 and break the scene.

The scene is loaded with `React.lazy`, so three.js is only downloaded when someone opens the twin page. After the build it sits in its own file (`StationScene-*.js`, 939 kB / 249 kB gzipped) and the main bundle stayed the same size as in Phase 8.

---

## 2. Components

```
src/twin/
├── StationScene.jsx    # Canvas, lights, ground, bay lines, camera, temperature post
├── Charger.jsx         # one pedestal: base, column, status panel, lamp, label
├── StatusLight.jsx     # lamp on top; pulses only during a simulated session
├── Vehicle.jsx         # block car + cable + SOC bar, only during a simulated session
├── Label.jsx           # text sprite (see section 6)
├── TelemetryPanel.jsx  # HTML panel next to the canvas: everything as text
└── twinState.js        # pure logic: colours, layout, what each bay may show
src/pages/Twin.jsx      # page: scene + bay buttons + panel + legend + table
```

Everything is built from simple shapes (boxes, cylinders, spheres, planes): ground, kerb, white bay lines, 4 charger pedestals, cars, cable. No downloaded 3D models. The plan said to start with primitives and only use licensed assets later.

---

## 3. Where the data comes from

The page uses `useStation()`, **the same hook the Overview table uses** (Phase 8). It does one `GET /api/stations/STATION-001`, then listens for `station:update` and `telemetry:reading` over Socket.IO. The scene, the bay buttons, the side panel and the table under it all render from that one object, so they can't show different things.

| In the scene | Data behind it | Source label |
|---|---|---|
| Colour of status panel + lamp | `charger.status` | set by operator (`manual`) or by a simulated session (`simulation`) |
| Car in a bay | an active simulated session on that bay | `simulation` |
| SOC bar + "SOC 54 %" label | `session.simulated.socPct`, computed by the backend from the clock | label says **simulated** |
| Pulsing lamp | same active session | — |
| Temperature post label | latest telemetry reading | label says **simulated** or **live sensor**, plus age ("3 s ago") |
| Bay label | bay number, rating, status | — |

### Status colours

As the plan specifies: **available green**, **charging blue**, **fault / maintenance red**, **offline gray**. An unknown status is drawn gray, not some new colour. A colour key sits under the canvas, and every status is also written as text on the bay label, the bay button and the table.

---

## 4. Only animating what has a source

From the plan: *"Animate only values that have a source"* and the pitfall *"permanently animating a charger after a timed-out request"*.

`bayVisual()` in `twinState.js` decides what a bay may show:

```js
const session = charger.status === 'charging' ? charger.session : null;
const sim = session?.simulated || null;
return {
  showVehicle: Boolean(session),
  animate: Boolean(sim),
  socPct: sim ? sim.socPct : null,
  ...
};
```

- A car, a moving SOC bar and a pulsing lamp appear **only** when the bay is `charging` **and** the backend has an active simulated session for it.
- A prediction request on its own never changes the scene. A timed-out or failed request leaves the bay as it was.
- If a bay is set to `fault` while a stale session object is still in the data, nothing is drawn for it (unit tested).
- When the simulated time runs out, the backend sweeper (Phase 7) frees the bay. The car disappears and the bay turns green without anyone touching the page (`03_after_session_ended.png`).
- The temperature post only turns green when the reading's source is `sensor`. A simulated reading stays gray, with a dashed "simulated" label.

The real ambient sensor arrives in Phase 10. Until then nothing in the scene is live hardware data, and the note under the table says so.

---

## 5. Clicking a bay

Clicking a charger in the 3D view (or one of the bay buttons, or "Bay N" in the table) selects it. The selected charger gets a blue ring on the ground and a highlighted label. Clicking empty space clears the selection. The panel next to the canvas then shows:

- status (text pill) and **who set it** (Manual / Simulated badge) + note
- charger type, rating, connector
- **last update time** (absolute and "2 min ago")
- **request id**, linking to that request's detail page (marked "(last)" when there's no current one)
- during a session: vehicle, simulated progress bar with SOC and kWh (badge **Simulated**), predicted energy (badge **ML estimate**), and a sentence saying the clock runs 60× faster and nothing comes from a car or meter
- whether the bay record itself is **Demo data**
- the latest ambient temperature with source, sensor id, timestamp and the "not battery temperature" label

---

## 6. A problem with drei's `<Html>` labels

The first version used drei's `<Html>` component for the floating labels (DOM elements placed in 3D). In the browser test the console filled with:

```
Attempted to synchronously unmount a root while React was already rendering. ...
NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.
```

Each `<Html>` creates its own React root, and React 19 complains when those are torn down during the frequent re-renders a live scene has (and when switching to 2D mode). Rather than fight it, I wrote `Label.jsx`: it draws the text onto a small `<canvas>`, uses that as a texture on a sprite (which always faces the camera), and disposes the texture when the text changes. No extra React roots, no font download (system font), and cheaper to render. After the change: **0 console errors**. Simulated values get a dashed brown border on their label, like the Simulated badge in the dashboard.

---

## 7. Performance

Tested in Microsoft Edge (Playwright) on this laptop. The GPU reported by WebGL was `ANGLE (AMD Radeon(TM) Graphics, Direct3D11)`, so the laptop's integrated graphics were in use, not software rendering.

| Measurement | Result |
|---|---|
| Frame rate with a session running (requestAnimationFrame over 3 s) | **60 fps** |
| WebGL draw calls in 3 s, nothing charging | **37** |
| WebGL draw calls in 3 s, one bay charging | **8,869** (~180 frames × ~49 objects) |

The difference comes from one setting: the canvas uses `frameloop="demand"` (draw only when something changed) unless a bay is actively charging, and only then switches to `"always"`. An idle twin page costs almost nothing, which matters on a laptop that is also running the backend. Other settings: device pixel ratio capped at 1.75, one shadow-casting light with a 1024 px shadow map, no textures apart from the labels. `prefers-reduced-motion` turns the pulsing off and keeps the scene on demand rendering.

The camera distance is worked out from the number of bays, so the whole row plus the temperature post fits. My first two tries were too close (the car was cut off) and then too far (everything tiny), until I used the horizontal view angle instead of the vertical one. The camera can rotate and zoom within limits but can't pan away or go under the ground.

---

## 8. Accessibility and the 2D fallback

The canvas itself can't be used with a keyboard or a screen reader, so it is never the only way to see or do something:

- The canvas wrapper has `role="img"` with a description that points to the bay list and table. The canvas is `aria-hidden`.
- **Bay buttons** next to the canvas (real `<button>`s with `aria-pressed`) select bays exactly like clicking in 3D. Tested with keyboard focus + Enter.
- The side panel is `aria-live="polite"`, so the selected bay's details are read out.
- **The same bays as a table** always sit under the canvas. Selecting a row there selects it in 3D too. Operators can also change a bay's status there.
- **"Show 2D table only"** button removes the canvas entirely.
- **No WebGL:** the page checks for WebGL first. If there isn't any, it never loads three.js and shows "3D view not available" with the bay buttons, panel and table. I tested this by starting Edge with the GPU and WebGL switched off: no canvas, 4 table rows, no errors (`05_no_webgl_fallback.png`).

---

## 9. Tests

```bash
cd laptop-1/frontend
npm test
#  Test Files  3 passed (3)
#       Tests  27 passed (27)
```

New `test/twin.test.js` (6 tests):

| Test | Checks |
|---|---|
| plan colours | available/charging/fault/offline map to green/blue/red/gray |
| unknown status | drawn as offline gray |
| layout | bays sorted by number and centred |
| charging bay with session | car + animation + SOC from the simulated session |
| bay with only a (timed-out) request | no car, no animation, no SOC |
| stale session on a fault bay | nothing drawn |

### In the browser (Edge, real GPU)

With backend, Mosquitto, stub worker and simulated telemetry running, I put the four bays in four different states through the API (bay 1 charging via a simulated session, bay 2 offline, bay 3 available, bay 4 fault) and opened `/twin`:

| Check | Result |
|---|---|
| Scene renders, all four colours, car only on bay 1 | yes (`01_twin_all_states_bay1_selected.png`) |
| SOC on the car label = SOC in the panel | both 54 % (same data) |
| Click on a charger **inside the canvas** | panel showed "Bay 1 ↯ Charging" |
| Keyboard: focus "Bay 3" button + Enter | panel showed "Bay 3 ○ Available" |
| **Live backend change:** `PATCH` bay 3 → fault while the page is open | bay 3 turned red **136 ms** later, no reload (`02_live_change_bay3_fault.png`) |
| Session reaches its predicted duration | car gone, bay 1 green, "Set by: Simulated" (`03_after_session_ended.png`) |
| "Show 2D table only" | canvas removed, table stays (`04_2d_table_mode.png`) |
| No WebGL | fallback page, 4 rows (`05_no_webgl_fallback.png`) |
| Console errors | none |

Backend tests are unchanged at 41/41 (no backend changes this phase).

Not tested: an older or weaker laptop than this one, and Safari/Firefox (only Edge was available for automated runs).

---

## 10. Plan checklist

| From the plan | Done |
|---|---|
| React Three Fiber/Drei, primitive geometry: ground, 2–4 bays, chargers, EV blocks, cables, status lights | yes, 4 bays from the database |
| `StationScene`, `Charger`, `Vehicle`, `StatusLight`, `TelemetryPanel`, driven by the same API/store as the dashboard | yes, all from `useStation()` |
| Available green, charging blue, fault red, offline gray; text/ARIA alternatives outside the canvas | yes, plus colour key, bay buttons, table |
| Animate only values with a source; simulated SOC says "simulated"; live temperature shows a timestamp | yes |
| Clicking a bay opens a panel with status, request id, source labels, last update time | yes |
| Loads on an ordinary laptop | 60 fps on integrated graphics, idle page almost no GPU work |
| Reflects at least one live backend state change | yes, 136 ms after a `PATCH` |
| Still useful with a 2D fallback / table | 2D toggle + automatic no-WebGL fallback |
| Pitfall: animating a charger after a timed-out request | can't happen: animation requires an active simulated session (unit tested) |

---

## 11. How to run the whole thing (Phases 6–9)

```bash
# Laptop 2: Mosquitto + Python worker (Phases 4–5)

# Laptop 1, terminal 1
cd laptop-1/backend
npm install
npm run db:setup          # first time only: indexes, demo station, CSV import
npm start

# Laptop 1, terminal 2
cd laptop-1/frontend
npm install
npm run dev               # open http://localhost:5173

# Without Laptop 2 (development only):
npm run dev:stub-worker   # in laptop-1/backend
npm run dev:sim-telemetry # simulated ambient temperature
```

Demo path: **New request** → pick a bay → **Send** → result page → **Start simulated session** → **Station twin (3D)** and watch the bay charge and then free up by itself.
