import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getSocket } from '../api/socket.js';
import { Notice } from '../components/Notice.jsx';
import { SourceBadge } from '../components/SourceBadge.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { TemperatureCard } from '../components/TemperatureCard.jsx';
import { useMeta } from '../hooks/MetaContext.jsx';
import { useApi } from '../hooks/useApi.js';
import { useStation } from '../hooks/useStation.js';
import { dateTime, num, timeOnly } from '../lib/format.js';
import { QUALITY_TEXT } from '../lib/sources.js';

const MAX_POINTS = 300;
const GAP_MS = 60_000;
// Sensor and simulated readings are separate lines, so one is never read as the other.
const SERIES = [
  { key: 'sensor', name: 'Live sensor', color: 'var(--series-1)' },
  { key: 'simulation', name: 'Simulated', color: 'var(--series-2)', dash: '6 4' },
];

function ChartTooltip({ active, payload }) {
  if (!active || !payload?.length || payload[0].payload.gap) return null;
  const p = payload[0].payload;
  return (
    <div className="chart-tip">
      <strong>{num(p.temperatureC, 1)} °C</strong>
      <span>{p.source === 'sensor' ? 'Live sensor' : 'Simulated'}</span>
      <span>{dateTime(p.timestamp)}</span>
    </div>
  );
}

export function Telemetry() {
  const { meta } = useMeta();
  const station = useStation(meta?.stationId);
  const history = useApi(meta ? `/api/telemetry?limit=${MAX_POINTS}` : null);
  const [showTable, setShowTable] = useState(false);
  const { setData } = history;

  useEffect(() => {
    const socket = getSocket();
    const onReading = (r) =>
      setData((d) => (d ? { items: [...d.items, r].slice(-MAX_POINTS) } : d));
    socket.on('telemetry:reading', onReading);
    return () => socket.off('telemetry:reading', onReading);
  }, [setData]);

  const rows = history.data?.items || [];
  // A gap of more than a minute means no data arrived; break the line there
  // instead of drawing a straight line through time with no readings.
  const points = useMemo(() => {
    const out = [];
    let prev = null;
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      if (prev !== null && t - prev > GAP_MS) out.push({ t: prev + 1, gap: true });
      out.push({ ...r, t, [r.source]: r.temperatureC });
      prev = t;
    }
    return out;
  }, [rows]);
  const present = SERIES.filter((s) => rows.some((r) => r.source === s.key));

  if (!meta || (history.loading && !history.data)) return <Loading what="telemetry" />;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Telemetry</h1>
          <p className="muted">Temperature readings received on <code>evdt/v1/telemetry/temperature</code>.</p>
        </div>
      </header>

      <Notice tone="warn" title="This is air temperature, not battery temperature">
        The sensor sits in the charger area and measures ambient temperature. It says nothing about the temperature of the cells inside
        a car. Until the Arduino gateway is running (Phase 10), readings here come from the simulator and are marked as simulated.
      </Notice>

      <div className="grid stats">
        <TemperatureCard reading={station.data?.telemetry} label={meta.labels?.ambientTemperature} />
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Last {MAX_POINTS} readings</h2>
          {rows.length > 0 && (
            <button type="button" className="btn btn-small" onClick={() => setShowTable((v) => !v)} aria-pressed={showTable}>
              {showTable ? 'Show chart' : 'Show as table'}
            </button>
          )}
        </div>
        <ErrorBox error={history.error} onRetry={history.reload} />
        {rows.length === 0 && (
          <Empty>
            No readings yet. Start the sensor gateway, or for testing run <code>npm run dev:sim-telemetry</code> in{' '}
            <code>laptop-1/backend</code> (those readings are labelled simulated).
          </Empty>
        )}
        {rows.length > 0 && !showTable && (
          <figure className="chart">
            <figcaption className="sr-only">Ambient temperature over time in degrees Celsius, split by data source.</figcaption>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={points} margin={{ top: 8, right: 24, bottom: 8, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis
                  dataKey="t"
                  type="number"
                  scale="time"
                  domain={['dataMin', 'dataMax']}
                  tickFormatter={timeOnly}
                  stroke="var(--axis)"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                />
                <YAxis
                  unit=" °C"
                  width={64}
                  tickFormatter={(v) => num(v, 1)}
                  domain={['auto', 'auto']}
                  stroke="var(--axis)"
                  tick={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }} />
                {present.length > 1 && <Legend wrapperStyle={{ color: 'var(--text-secondary)', fontSize: 13 }} />}
                {present.map((s) => (
                  <Line
                    key={s.key}
                    dataKey={s.key}
                    name={s.name}
                    stroke={s.color}
                    strokeWidth={2}
                    strokeDasharray={s.dash}
                    dot={false}
                    activeDot={{ r: 4, stroke: 'var(--surface)', strokeWidth: 2 }}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
            {present.length === 1 && <p className="small muted">All readings shown are {present[0].name.toLowerCase()}.</p>}
          </figure>
        )}
        {rows.length > 0 && showTable && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Temperature readings, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Temperature</th>
                  <th scope="col">Source</th>
                  <th scope="col">Quality</th>
                  <th scope="col">Sensor</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().slice(0, 100).map((r) => (
                  <tr key={`${r.timestamp}-${r.sensorId}-${r.temperatureC}`}>
                    <td>{dateTime(r.timestamp)}</td>
                    <td>{num(r.temperatureC, 2)} °C</td>
                    <td>
                      <SourceBadge source={r.source} small />
                    </td>
                    <td>{QUALITY_TEXT[r.quality] || r.quality}</td>
                    <td>{r.sensorId || '–'}</td>
                    <td className="small">{r.qualityNotes?.join('; ') || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
