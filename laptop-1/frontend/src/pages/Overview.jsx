import { Link } from 'react-router-dom';
import { ChargerTable } from '../components/ChargerTable.jsx';
import { SourceBadge } from '../components/SourceBadge.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { TemperatureCard } from '../components/TemperatureCard.jsx';
import { useMeta } from '../hooks/MetaContext.jsx';
import { useApi } from '../hooks/useApi.js';
import { useStation } from '../hooks/useStation.js';
import { hoursToHm, num, shortId, timeOnly } from '../lib/format.js';

export function Overview() {
  const { meta } = useMeta();
  const stationId = meta?.stationId;
  const station = useStation(stationId);
  const recent = useApi('/api/predictions?limit=5');
  const alerts = useApi('/api/alerts?status=open&limit=100');

  if (!stationId || (station.loading && !station.data)) return <Loading what="station" />;
  if (station.error && !station.data) return <ErrorBox error={station.error} onRetry={station.reload} />;
  const view = station.data;
  const counts = view.chargers.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] || 0) + 1 }), {});

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{view.station.name}</h1>
          <p className="muted">
            {view.station.stationId}
            {view.station.maxPowerKw ? ` · site limit ${view.station.maxPowerKw} kW` : ''}
          </p>
        </div>
        <SourceBadge source={view.station.source} isDemo={view.station.isDemo} />
      </header>

      <div className="grid stats">
        <section className="card stat">
          <h3>Bays</h3>
          <p className="stat-value">{view.chargers.length}</p>
          <p className="small">
            {['available', 'charging', 'fault', 'offline']
              .filter((s) => counts[s])
              .map((s) => `${counts[s]} ${s}`)
              .join(' · ') || 'none configured'}
          </p>
        </section>
        <TemperatureCard reading={view.telemetry} label={meta?.labels?.ambientTemperature} />
        <section className="card stat">
          <h3>Open alerts</h3>
          <p className="stat-value">{alerts.data ? alerts.data.items.length : '–'}</p>
          <p className="small">
            <Link to="/alerts">See alerts</Link>
          </p>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Bays</h2>
          <div className="actions">
            <Link className="btn" to="/twin">
              Open 3D view
            </Link>
            <Link className="btn" to="/requests/new">
              New charging request
            </Link>
          </div>
        </div>
        {view.chargers.length === 0 ? (
          <Empty>
            No chargers in the database. Run <code>npm run db:seed</code> in <code>laptop-1/backend</code>.
          </Empty>
        ) : (
          <ChargerTable station={view} onChanged={station.reload} />
        )}
        <p className="small muted">
          Bay status is set by an operator or by a simulated session. No real charger is read or controlled.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Latest requests</h2>
          <Link to="/requests">All requests</Link>
        </div>
        {recent.error && <ErrorBox error={recent.error} onRetry={recent.reload} />}
        {recent.data?.items?.length === 0 && <Empty>No prediction requests yet.</Empty>}
        {recent.data?.items?.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Five most recent prediction requests</caption>
              <thead>
                <tr>
                  <th scope="col">Sent</th>
                  <th scope="col">Request</th>
                  <th scope="col">Vehicle</th>
                  <th scope="col">Status</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Energy</th>
                </tr>
              </thead>
              <tbody>
                {recent.data.items.map((r) => (
                  <tr key={r.requestId}>
                    <td>{timeOnly(r.createdAt)}</td>
                    <td>
                      <Link to={`/requests/${r.requestId}`}>
                        <code>{shortId(r.requestId)}</code>
                      </Link>
                    </td>
                    <td>{r.input.vehicle.model}</td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td>{r.result ? hoursToHm(r.result.predictions.durationHours) : '–'}</td>
                    <td>{r.result ? `${num(r.result.predictions.energyKwh, 1)} kWh` : '–'}</td>
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
