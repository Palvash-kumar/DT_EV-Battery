import { ago, num } from '../lib/format.js';

const STATE = {
  live: { text: 'Live', symbol: '●', kind: 'ok' },
  suspect: { text: 'Suspect reading', symbol: '!', kind: 'warn' },
  offline: { text: 'Sensor offline', symbol: '–', kind: 'bad' },
  none: { text: 'No sensor data', symbol: '○', kind: 'muted' },
};

// Health of the real Arduino ambient sensor, in words, symbol and colour.
export function SensorStatus({ reading, health, now }) {
  const s = STATE[health.state];
  return (
    <div className={`sensor-status sensor-${health.state}`} role="status" aria-live="polite">
      <p>
        <span className={`pill pill-${s.kind}`}>
          <span aria-hidden="true">{s.symbol}</span> {s.text}
        </span>{' '}
        <strong>Arduino sensor</strong>
        {reading && (
          <>
            {' '}
            · {reading.sensorId || 'unknown id'} · <strong>{num(reading.temperatureC, 2)} °C</strong> · read {ago(reading.timestamp, now)}
          </>
        )}
      </p>
      {health.state === 'live' ? (
        <p className="small muted">
          Updates by itself every few seconds. Calibration: {reading.calibrationStatus || 'unknown'}.
        </p>
      ) : (
        <p className="small">{health.reason}</p>
      )}
      {(health.state === 'offline' || health.state === 'none') && (
        <p className="small muted">
          Check the chain: on the sensor laptop <code>npm run opcua:server</code> in <code>laptop-sensor</code> (Arduino IDE Serial
          Monitor closed), and on the Mac <code>python opcua_bridge/bridge.py</code> in <code>laptop-2</code>.
        </p>
      )}
    </div>
  );
}
