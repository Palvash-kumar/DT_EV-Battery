import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Notice } from '../components/Notice.jsx';
import { SourceBadge } from '../components/SourceBadge.jsx';
import { ErrorBox, Loading } from '../components/States.jsx';
import { useApi } from '../hooks/useApi.js';
import { num } from '../lib/format.js';
import { QUALITY_TEXT, SOURCE_BADGES } from '../lib/sources.js';

const COLLECTION_TEXT = {
  stations: 'Stations',
  chargers: 'Charger bays',
  vehicles: 'Vehicle profiles',
  batteries: 'Battery packs',
  chargingSessions: 'Charging sessions',
  predictionRequests: 'Prediction results',
  telemetryReadings: 'Temperature readings',
  healthEstimates: 'Health estimates',
  alerts: 'Alerts',
  optimizationPlans: 'Optimization plans',
};

function BarTip({ active, payload, unit, what }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="chart-tip">
      <strong>
        {num(p.value, unit === 'sessions' ? 0 : 1)} {unit}
      </strong>
      <span>
        {what} {p.payload.label}
      </span>
      {p.payload.sessions !== undefined && unit !== 'sessions' && <span>{p.payload.sessions} sessions</span>}
    </div>
  );
}

function SimpleBars({ data, dataKey, unit, what, caption, height = 240, labels = true, tickInterval = 0, note }) {
  return (
    <figure className="chart">
      <figcaption>{caption}</figcaption>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 20, right: 8, bottom: 4, left: 0 }} barCategoryGap="20%">
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis dataKey="label" stroke="var(--axis)" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} interval={tickInterval} />
          <YAxis stroke="var(--axis)" tick={{ fill: 'var(--text-secondary)', fontSize: 12 }} width={44} />
          <Tooltip content={<BarTip unit={unit} what={what} />} cursor={{ fill: 'var(--hover)' }} />
          <Bar dataKey={dataKey} fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {labels && (
              <LabelList dataKey={dataKey} position="top" formatter={(v) => num(v, 1)} style={{ fill: 'var(--text-secondary)', fontSize: 12 }} />
            )}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {note && <p className="small muted">{note}</p>}
    </figure>
  );
}

export function Provenance() {
  const prov = useApi('/api/provenance');
  const summary = useApi('/api/sessions/summary');
  const [tableView, setTableView] = useState(false);

  if ((prov.loading && !prov.data) || (summary.loading && !summary.data)) return <Loading what="provenance" />;
  const s = summary.data;
  const byType = s?.byChargerType.map((r) => ({ ...r, label: r.key })) || [];
  const byHour = s?.byHourUtc.map((r) => ({ ...r, label: String(r.hour).padStart(2, '0') })) || [];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Data provenance</h1>
          <p className="muted">Where every stored value came from, and how much of each kind there is.</p>
        </div>
      </header>

      <section className="card">
        <h2>What the labels mean</h2>
        <dl className="legend-list">
          {Object.entries(SOURCE_BADGES).map(([key, b]) => (
            <div key={key}>
              <dt>
                <SourceBadge source={key === 'demo' ? 'manual' : key} isDemo={key === 'demo'} />
              </dt>
              <dd>{b.help}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card">
        <h2>Stored records by source</h2>
        <ErrorBox error={prov.error} onRetry={prov.reload} />
        {prov.data && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Record counts per collection, source and quality</caption>
              <thead>
                <tr>
                  <th scope="col">Collection</th>
                  <th scope="col">Source</th>
                  <th scope="col">Quality</th>
                  <th scope="col" className="num">
                    Records
                  </th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(prov.data.collections).flatMap(([name, rows]) =>
                  (rows.length ? rows : [{ source: '–', count: 0 }]).map((r, i) => (
                    <tr key={`${name}-${i}`}>
                      {i === 0 && (
                        <th scope="rowgroup" rowSpan={Math.max(rows.length, 1)}>
                          {COLLECTION_TEXT[name] || name}
                        </th>
                      )}
                      <td>{SOURCE_BADGES[r.source] || r.isDemo ? <SourceBadge source={r.source} isDemo={r.isDemo} small /> : r.source}</td>
                      <td>{r.quality ? QUALITY_TEXT[r.quality] || r.quality : '–'}</td>
                      <td className="num">{r.count}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {s && (
        <section className="card">
          <div className="card-head">
            <h2>
              Historical sessions <SourceBadge source="historical_csv" small />
            </h2>
            <button type="button" className="btn btn-small" onClick={() => setTableView((v) => !v)} aria-pressed={tableView}>
              {tableView ? 'Show charts' : 'Show as table'}
            </button>
          </div>
          <p className="small">
            {s.totalSessions} rows imported from <code>Data/ev_charging_patterns.csv</code>. Checked against the Phase 1 rules:{' '}
            {['good', 'suspect', 'bad'].map((q) => `${s.quality[q] || 0} ${QUALITY_TEXT[q].toLowerCase()}`).join(', ')}. No row was
            changed or dropped.
          </p>

          {!tableView ? (
            <div className="grid two">
              <SimpleBars data={byType} dataKey="avgRateKw" unit="kW" what="Average charging rate," caption="Average charging rate by charger type (kW)" />
              <SimpleBars data={byType} dataKey="avgEnergyKwh" unit="kWh" what="Average energy," caption="Average energy per session by charger type (kWh)" />
              <SimpleBars
                data={byHour}
                dataKey="sessions"
                unit="sessions"
                what="Sessions starting at hour"
                caption="Sessions by start hour (UTC)"
                labels={false}
                tickInterval={2}
                note="Exactly 55 sessions in every hour: the CSV start times are one row per hour in sequence, so this shows no real daily demand pattern."
              />
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <caption>Historical sessions by charger type</caption>
                <thead>
                  <tr>
                    <th scope="col">Charger type</th>
                    <th scope="col" className="num">Sessions</th>
                    <th scope="col" className="num">Avg rate (kW)</th>
                    <th scope="col" className="num">Avg energy (kWh)</th>
                    <th scope="col" className="num">Avg duration (h)</th>
                  </tr>
                </thead>
                <tbody>
                  {byType.map((r) => (
                    <tr key={r.key}>
                      <th scope="row">{r.key}</th>
                      <td className="num">{r.sessions}</td>
                      <td className="num">{num(r.avgRateKw, 1)}</td>
                      <td className="num">{num(r.avgEnergyKwh, 1)}</td>
                      <td className="num">{num(r.avgDurationHours, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Notice tone="warn" title="Read these with care">
            The average rate is about 26 kW for every charger type, including Level 1, which in reality delivers roughly 1–2 kW. In this
            dataset the charger type is not linked to the rate, which is one reason the duration and energy models score close to zero.
          </Notice>
        </section>
      )}
    </>
  );
}
