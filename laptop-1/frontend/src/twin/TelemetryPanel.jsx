import { Link } from 'react-router-dom';
import { SessionProgress } from '../components/ChargerTable.jsx';
import { SourceBadge } from '../components/SourceBadge.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { ago, dateTime, num, shortId } from '../lib/format.js';

// Plain HTML next to the canvas: everything the scene shows, as text.
export function TelemetryPanel({ view, selectedId }) {
  const charger = view.chargers.find((c) => c.chargerId === selectedId);
  const t = view.telemetry;

  return (
    <aside className="twin-panel" aria-live="polite">
      {charger ? (
        <section>
          <h2>
            Bay {charger.bay} <StatusPill status={charger.status} />
          </h2>
          <dl className="facts">
            <dt>Charger</dt>
            <dd>
              {charger.chargerType}, {charger.maxPowerKw} kW, {charger.connector || 'connector n/a'}
            </dd>
            <dt>Status set by</dt>
            <dd>
              <SourceBadge source={charger.statusSource} small />
              {charger.statusNote ? ` ${charger.statusNote}` : ''}
            </dd>
            <dt>Last update</dt>
            <dd>
              {dateTime(charger.statusUpdatedAt)} ({ago(charger.statusUpdatedAt)})
            </dd>
            <dt>Request</dt>
            <dd>
              {charger.currentRequestId || charger.lastRequestId ? (
                <Link to={`/requests/${charger.currentRequestId || charger.lastRequestId}`}>
                  <code>{shortId(charger.currentRequestId || charger.lastRequestId)}</code>
                </Link>
              ) : (
                '–'
              )}
              {!charger.currentRequestId && charger.lastRequestId ? ' (last)' : ''}
            </dd>
            {charger.session && (
              <>
                <dt>Vehicle</dt>
                <dd>{charger.session.vehicleModel}</dd>
                <dt>Session</dt>
                <dd>
                  <SessionProgress session={charger.session} />
                </dd>
                <dt>Predicted energy</dt>
                <dd>
                  {num(charger.session.simulation?.predictedEnergyKwh, 1)} kWh <SourceBadge source="ml_estimate" small />
                </dd>
              </>
            )}
            <dt>Bay record</dt>
            <dd>
              <SourceBadge source={charger.source} isDemo={charger.isDemo} small />
            </dd>
          </dl>
          {charger.session && (
            <p className="small muted">
              SOC and energy move with a clock running {charger.session.simulated?.timeScale}× faster than real time. Nothing is read from a
              car or a meter.
            </p>
          )}
        </section>
      ) : (
        <p className="muted">Select a bay in the scene or in the list to see its details.</p>
      )}

      <section>
        <h3>Ambient temperature</h3>
        {t ? (
          <p>
            <strong>{num(t.temperatureC, 1)} °C</strong> <SourceBadge source={t.source} small />
            <br />
            <span className="small">
              {t.sensorId} · {dateTime(t.timestamp)} · {t.label}
            </span>
          </p>
        ) : (
          <p className="small muted">No reading received.</p>
        )}
      </section>
    </aside>
  );
}
