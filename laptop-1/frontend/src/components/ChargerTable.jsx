import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { ago, num, shortId } from '../lib/format.js';
import { SourceBadge } from './SourceBadge.jsx';
import { StatusPill } from './StatusPill.jsx';

export function SessionProgress({ session }) {
  const sim = session?.simulated;
  if (!sim) return null;
  return (
    <div className="progress-cell">
      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={sim.progressPct}
        aria-label="Simulated charging progress"
      >
        <span style={{ width: `${sim.progressPct}%` }} />
      </div>
      <span>
        SOC {num(sim.socPct, 0)} % · {num(sim.energyKwh, 1)} kWh
      </span>
      <SourceBadge source="simulation" small />
    </div>
  );
}

// Operator status change. 'charging' isn't offered: only a simulated session
// can put a bay into that state.
function StatusControl({ charger, stationId, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const options = ['available', 'fault', 'offline'].filter((s) => s !== charger.status);

  const change = async (e) => {
    const status = e.target.value;
    if (!status) return;
    e.target.value = '';
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/api/stations/${stationId}/chargers/${charger.chargerId}`, { status });
      onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="sr-only" htmlFor={`status-${charger.chargerId}`}>
        Change status of bay {charger.bay}
      </label>
      <select id={`status-${charger.chargerId}`} defaultValue="" onChange={change} disabled={busy}>
        <option value="">Set status…</option>
        {options.map((o) => (
          <option key={o} value={o} disabled={o === 'available' && charger.status === 'charging'}>
            {o}
          </option>
        ))}
      </select>
      {error && <p className="field-error">{error}</p>}
    </>
  );
}

export function ChargerTable({ station, onChanged, selected, onSelect, caption = 'Charger bays' }) {
  const { chargers = [] } = station;
  return (
    <div className="table-wrap">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Bay</th>
            <th scope="col">Type</th>
            <th scope="col">Rating</th>
            <th scope="col">Status</th>
            <th scope="col">Set by</th>
            <th scope="col">Session</th>
            <th scope="col">Request</th>
            <th scope="col">Updated</th>
            {onChanged && <th scope="col">Operator</th>}
          </tr>
        </thead>
        <tbody>
          {chargers.map((c) => (
            <tr key={c.chargerId} className={selected === c.chargerId ? 'row-selected' : undefined}>
              <th scope="row">
                {onSelect ? (
                  <button type="button" className="link-btn" onClick={() => onSelect(c.chargerId)} aria-pressed={selected === c.chargerId}>
                    Bay {c.bay}
                  </button>
                ) : (
                  `Bay ${c.bay}`
                )}
              </th>
              <td>{c.chargerType}</td>
              <td>{c.maxPowerKw} kW</td>
              <td>
                <StatusPill status={c.status} />
              </td>
              <td>
                <SourceBadge source={c.statusSource} small />
              </td>
              <td>{c.session ? <SessionProgress session={c.session} /> : <span className="muted">–</span>}</td>
              <td>
                {c.currentRequestId || c.lastRequestId ? (
                  <Link to={`/requests/${c.currentRequestId || c.lastRequestId}`}>
                    <code>{shortId(c.currentRequestId || c.lastRequestId)}</code>
                  </Link>
                ) : (
                  <span className="muted">–</span>
                )}
              </td>
              <td>{ago(c.statusUpdatedAt)}</td>
              {onChanged && (
                <td>
                  <StatusControl charger={c} stationId={station.station.stationId} onChanged={onChanged} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
