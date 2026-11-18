import { ago, num } from '../lib/format.js';
import { QUALITY_TEXT } from '../lib/sources.js';
import { SourceBadge } from './SourceBadge.jsx';

// Latest ambient reading. Always says "ambient" and where the value came from.
export function TemperatureCard({ reading, label }) {
  if (!reading) {
    return (
      <section className="card stat">
        <h3>Ambient temperature</h3>
        <p className="stat-value muted">No reading</p>
        <p className="small">Nothing has arrived on the telemetry topic yet. No value is shown rather than a made-up one.</p>
      </section>
    );
  }
  const stale = reading.ageSec > 120;
  return (
    <section className="card stat">
      <h3>Ambient temperature</h3>
      <p className="stat-value">
        {num(reading.temperatureC, 1)} <span className="unit">°C</span>
      </p>
      <p className="small">{reading.label || label}</p>
      <p className="badges">
        <SourceBadge source={reading.source} />
        <span className={`quality quality-${reading.quality}`}>{QUALITY_TEXT[reading.quality] || reading.quality}</span>
      </p>
      <p className={`small${stale ? ' warn-text' : ''}`}>
        {reading.sensorId ? `${reading.sensorId} · ` : ''}
        {stale ? 'Stale: last reading ' : 'Read '}
        {ago(reading.timestamp)}
      </p>
    </section>
  );
}
