# Phase 8 — React Dashboard and User Workflow

Goal of this phase: a dashboard on Laptop 1 that a first-time user can work without reading logs. They should be able to send a charging request, follow it to a result, understand the result and where it came from, and look back at history. The other rule from the plan was that the dashboard must never mix up simulated values, ML estimates and live readings.

The browser talks only to the Laptop 1 backend (REST + Socket.IO). It never connects to MQTT or Laptop 2.

Screenshots are in `what_I_did/screenshots/phase8/`.

---

## 1. Setup

```bash
cd laptop-1/frontend
cp .env.example .env      # VITE_BACKEND_URL=http://localhost:3000
npm install
npm run dev               # http://localhost:5173
```

| Package | Why |
|---|---|
| `react` / `react-dom` 19.3 | UI. Pinned below 19.4 because React Three Fiber 9 (Phase 9) supports `>=19 <19.4` |
| `react-router-dom` 7 | pages |
| `recharts` 3 | charts |
| `socket.io-client` 4 | live updates |
| `vite` 8 | dev server + build |
| `vitest`, `@testing-library/react`, `jsdom` (dev) | tests |

No CSS framework. `src/styles.css` is plain CSS with colour variables, with a dark-mode set that follows the operating system setting.

In development Vite proxies `/api` and `/socket.io` to the backend, so the page and the API have the same origin and the browser never needs Laptop 2's address.

`npm audit` reports one high-severity advisory in `picomatch` (ReDoS). It comes in through Vite and Vitest tooling only; it isn't in the code sent to the browser. npm's only suggested fix is downgrading to Vite 6, so I left it.

---

## 2. What the user enters and what they get back

This was the question for this phase, so here it is in one place.

### Input (New request page)

The form is built from `GET /api/meta`, which reads the allowed values and limits straight out of `shared/schemas/charging-request.schema.json`. The form, the backend and the Python worker therefore always agree.

| Field | Unit / allowed values | Notes |
|---|---|---|
| Demo profile | optional | fills model, capacity, age from the seeded vehicle profiles |
| Vehicle model | BMW i3, Chevy Bolt, Hyundai Kona, Nissan Leaf, Tesla Model 3 | only the models the ML model was trained on |
| Battery capacity | kWh, > 0 and ≤ 300 | |
| Vehicle age | years, 0–30 | |
| Current SOC / Target SOC | %, target must be above current | |
| Charger bay | optional | picking a bay locks the charger type and caps the rate at the bay's rating |
| Charger type | Level 1, Level 2, DC Fast Charger | |
| Requested rate | kW, > 0 and ≤ 350 (or the bay rating) | |
| Temperature source | Manual / Simulated / Live sensor | "Live sensor" can only be picked when a real sensor reading arrived in the last 2 minutes. It then fills the value and makes it read-only |
| Ambient temperature | °C, −50 to 60 | hint says "not battery temperature" |

Under the form it says which badge the temperature will be stored with, and gives a simple reference: `capacity × ΔSOC = kWh added to the battery, before charging losses`.

Fields are checked in the browser with the same rules as the server (`src/lib/validateRequest.js`). Each error appears under its field. If the server still rejects something, its field-level errors (`charging.targetSocPct` etc.) are mapped back onto the same fields.

### Output (Request detail page)

| Shown | Where it comes from |
|---|---|
| Lifecycle: Draft → Sent → Processing → Completed / Timed out / Failed | request status, live over Socket.IO, polling as fallback |
| Countdown while processing ("times out in 11 s") | `sentAt` + timeout from `/api/meta` |
| **Estimated charging duration** in "1 h 01 min" and hours | `result.predictions.durationHours` |
| **Estimated energy delivered** in kWh, with the simple reference next to it | `result.predictions.energyKwh` |
| Badge: **ML estimate**, or **Simulated** + a warning box if it came from the dev stub worker | `result.source` |
| Model versions, predicted-at (Laptop 2), received-at (Laptop 1), round-trip ms, attempts | result fields |
| Warnings sent by the worker | `result.warnings` |
| "How far to trust these numbers": selected model, test MAE, R² | `models` in `/api/meta`, read from `laptop-2/models/*_metadata.json` |
| Error code and plain-English reason when failed | `error` |
| Retry button (timed out, or broker was down) | `POST /retry` |
| "Play it on a bay": start a simulated session | Phase 7 sessions API |
| Input summary, with the temperature's source badge | `input` |
| Audit trail table: every status change, note, MQTT messageId | `statusHistory` |

The "how far to trust" box shows the real held-out figures, for example *MedianBaseline … MAE 0.86 hours, R² −0.02*. It explains that R² near zero means "about as good as always guessing the average". With the current models that is the honest summary, and hiding it would make the big numbers look more solid than they are.

---

## 3. Pages

| Page | Path | What's on it |
|---|---|---|
| Overview | `/` | station name with **Demo data** badge, bay counts, latest ambient temperature, open alerts, bay table with live simulated progress and an operator status menu, last 5 requests |
| New request | `/requests/new` | the form above + lifecycle at "Draft" |
| Request history | `/requests` | filter chips (all / processing / completed / timed out / failed), "Load older" paging, live row updates, result source column |
| Request detail | `/requests/:id` | the output above |
| Battery health | `/battery` | SOH, RUL, capacity loss, applicability notes, held-out accuracy, "what this page does not claim" |
| Telemetry | `/telemetry` | latest reading, chart of the last 300 readings split by source, table view |
| Alerts | `/alerts` | filter by status, severity, occurrences, evidence, suggested check, Acknowledge / Resolve, history |
| Optimization | `/optimization` | "advice only" note; empty until Phase 11 |
| Data provenance | `/provenance` | what each badge means, record counts by collection/source/quality, charts of the historical CSV |

The header shows Backend / MQTT broker / MongoDB / Live updates status (polled from `/api/health` every 15 s and refreshed on `service:status` events), and when the ML worker last answered.

---

## 4. Source badges

`src/lib/sources.js` + `SourceBadge.jsx`. The four names the plan asked for plus two:

| Badge | Used for |
|---|---|
| ● **Live sensor** | readings with `source: sensor` |
| ◇ **Simulated** (dashed border) | simulator readings, simulated sessions, stub-worker results |
| ≈ **ML estimate** | model outputs |
| ▤ **Historical** | rows from the CSV |
| ✎ **Manual** | typed in by a person, or set by an operator |
| ◌ **Demo data** (dotted border) | anything from the seed script; wins over the stored source |

Each badge has a symbol, a word and a border style, so it still reads without colour (colour-blind users, black-and-white printouts). Status pills work the same way ("✓ Completed", "⏱ Timed out", "✕ Failed"). An unknown source shows **"Unknown source"** instead of nothing.

---

## 5. Wording from `battery_model_limitations.md`

| Limitation doc says | Dashboard does |
|---|---|
| SOH label: "Model estimate from aging-data domain", not "Measured EV SOH" | exact text under the SOH number (comes from the API) |
| RUL label: "Estimated RUL (model, lab conditions)" | exact text under the RUL number |
| 80 % threshold is a configurable assumption | "That threshold is a configurable assumption, not a physical limit." |
| Single chemistry, synthetic data | warning box at the top naming Li-ion 18650 LiCoO2 and synthetic curves |
| "What must not be claimed" (section 3) | listed on the page with ✕ marks |
| Arduino temperature is ambient | Telemetry warning box, temperature card label, form hint |
| Lab-to-field transfer needs BMS calibration | closing line on the Battery page |

The held-out SOH/RUL scores look very good (R² 0.995). The page adds that they were measured on curves from the same synthetic generator, so they show the model learned the generator, not that it works on real batteries.

The only health estimate in the database right now is the seeded demo record, and the page says so in its own box.

---

## 6. Live updates

- One Socket.IO connection for the app (`src/api/socket.js`). Components join rooms (`station:<id>`, `request:<id>`) while mounted, and rooms are re-joined after a reconnect.
- `useStation()` is the single source of station state: one GET, then `station:update` and `telemetry:reading` events. Phase 9's 3D scene uses the same hook, so the table and the scene can't disagree.
- Simulated progress is computed by the backend from the clock, so while a bay is charging the station view refreshes every 3 s.
- The request page polls every 3 s while pending, in case a socket event is missed. A pending request is never shown as success.

---

## 7. Charts

All charts follow one set of rules. I validated the two series colours (blue `#2a78d6` / orange `#eb6834`, darker steps for dark mode) for colour-blind separation and contrast in both modes before using them.

- **Telemetry:** one line per source (Live sensor solid blue, Simulated dashed orange), so a simulated reading can never look like part of the sensor line. There's a hover tooltip with value, source and time, and a "Show as table" switch.
- **Provenance:** average rate and average energy by charger type, and sessions by start hour, each with a table view.

Two problems I only saw by looking at the rendered pages (I drove Edge headless with Playwright and screenshotted every page in light and dark mode):

1. **The telemetry line bridged an 18-minute gap** when the simulator wasn't running, drawing readings that never existed. The chart now breaks the line wherever readings are more than 60 s apart.
2. **The hour labels on the provenance chart overlapped** ("000102…"). Now every third hour is labelled.

And two things the charts showed about the data, which are now written under them:

- the average rate is ~26 kW for **every** charger type, Level 1 included (real Level 1 is ~1–2 kW);
- there are **exactly 55 sessions in every hour**. I checked it in MongoDB: all 24 hours have 55. The CSV start times are just one row per hour in sequence, so the "time of day" chart has no real demand pattern in it.

---

## 8. Loading, empty and error states

Every page handles all four cases: loading, error (with a "Try again" button), empty (it says what would fill it, e.g. *run `npm run dev:sim-telemetry`*), and data. When there is no temperature reading the card says **"No reading"** rather than showing a placeholder number.

An error boundary around the pages keeps one broken page from blanking the app. It resets when you navigate.

**A bug the browser run found:** the overview crashed on first load with `Cannot read properties of null (reading 'chargers')`. `useApi` started with `loading: false` while its URL was still `null` (the station id comes from `/api/meta`), so for one render the page saw "not loading, no data". `useApi` now counts as loading whenever it has no answer for the *current* URL yet. That fixed it everywhere, not just on the overview.

---

## 9. Accessibility

- Every input has a `<label>`. Errors are linked with `aria-describedby` and fields get `aria-invalid`.
- Status is never colour-only (symbol + text).
- The lifecycle has `aria-live="polite"` and `aria-current="step"`, so a screen reader hears "Status: Timed out".
- Tables have captions and header cells. Progress bars are real `role="progressbar"` with values.
- There's a skip-to-content link and visible focus outlines.
- The pulsing dot respects `prefers-reduced-motion`.
- Under 820 px wide the side menu becomes a horizontal strip, and wide tables scroll inside their card (`09_mobile.png`, 390 px wide).

---

## 10. Tests

```bash
cd laptop-1/frontend
npm test
#  Test Files  2 passed (2)
#       Tests  21 passed (21)
```

| File | Tests |
|---|---|
| `test/logic.test.js` (15) | badge names match the plan; Demo beats stored source; unknown source labelled; lifecycle states for draft / pending / completed / timed out / failed (pending is never "done"); form rules (SOC order, bay rating cap, empty/out-of-range values); request body uses numbers; server error paths map to fields; `2.1731 h → "2 h 10 min"` |
| `test/components.test.jsx` (6) | badge and status pill have text; lifecycle announces the step; temperature card says "not battery temperature" and shows Simulated; "No reading" when empty; charger table progress bar labelled simulated, with the request id |

Backend tests are still 41/41 after this phase's small backend change (model cards on `/api/meta`).

### End-to-end in a real browser

With backend, local Mosquitto, stub worker and simulated telemetry running, a Playwright script in Edge:

1. opened the overview;
2. sent the form with target SOC 20 % < 25 % → error shown under the field, nothing sent (`02_new_request_validation.png`);
3. picked the Chevy Bolt profile, bay 3, simulated temperature, sent it → landed on the detail page, result in 691 ms, badge "Simulated" + "Not from the ML model" box because the stub answered (`05_result.png`);
4. started a simulated session on bay 3 → overview showed bay 3 "Charging", progress bar and SOC, all labelled simulated (`01_overview.png`);
5. visited every other page, then repeated it all in dark mode and at phone width.

Then the failure path: I stopped the stub worker and sent a request. The page counted down ("times out in 11 s", `03_processing_countdown.png`), switched to **Timed out** at 15 s, I restarted the worker and clicked **Retry**, and it completed on attempt 2. The audit trail shows all six steps with two different MQTT message ids (`04_timed_out_then_retried.png`).

Console errors over all runs: none, apart from a favicon 404, which an inline icon in `index.html` now fixes.

Not tested here: the real Python worker behind the dashboard (I did that end to end in Phase 6 with curl; the dashboard only reads what the backend stored), and two physical laptops.

---

## 11. Files

```
laptop-1/frontend/
├── index.html, vite.config.js, package.json, .env.example
├── src/
│   ├── main.jsx, App.jsx, styles.css
│   ├── api/client.js            # fetch wrapper, error shape
│   ├── api/socket.js            # one Socket.IO connection, rooms
│   ├── hooks/useApi.js, useStation.js, useServiceStatus.js, MetaContext.jsx
│   ├── lib/format.js, sources.js, validateRequest.js
│   ├── components/ Layout, SourceBadge, StatusPill, Lifecycle, ChargerTable,
│   │               TemperatureCard, Notice, States, ErrorBoundary
│   └── pages/ Overview, NewRequest, RequestHistory, RequestDetail, BatteryHealth,
│              Telemetry, Alerts, Optimization, Provenance
└── test/ setup.js, logic.test.js, components.test.jsx

laptop-1/backend/src/domain/modelCards.js   # held-out scores for /api/meta
```

## 12. Plan checklist

| From the plan | Done |
|---|---|
| Pages: Overview, New Request, Session/Prediction Detail, Battery Health, Telemetry, Alerts, Optimization, Data Provenance | yes, plus Request History |
| Form matches the versioned schema, browser validation, server errors shown | built from `/api/meta`; errors per field |
| Lifecycle Draft → Sent → Processing → Completed / Timed out / Failed; polling and/or Socket.IO | both |
| Units, generation time, model version, caveats, uncertainty | yes; held-out MAE/R² shown with every prediction |
| Badges Live sensor / Simulated / ML estimate / Historical | yes, plus Manual and Demo |
| Recharts trends, accessible tables, empty/loading/error states, responsive | yes, every chart has a table view |
| No calls to Laptop 2 from React; pending ≠ success; not colour-only; limitations visible | yes |

The production bundle is 814 kB (239 kB gzipped) and Vite warns about it. Phase 9 loads the 3D scene only when it's opened, so three.js won't add to the first load.
