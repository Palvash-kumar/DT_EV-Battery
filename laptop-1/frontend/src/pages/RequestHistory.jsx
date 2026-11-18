import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { getSocket } from '../api/socket.js';
import { SourceBadge } from '../components/SourceBadge.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { useMeta } from '../hooks/MetaContext.jsx';
import { useStation } from '../hooks/useStation.js';
import { dateTime, hoursToHm, num, shortId } from '../lib/format.js';

const FILTERS = [
  { value: '', label: 'All' },
  { value: 'pending', label: 'Processing' },
  { value: 'completed', label: 'Completed' },
  { value: 'timed_out', label: 'Timed out' },
  { value: 'failed', label: 'Failed' },
];

export function RequestHistory() {
  const { meta } = useMeta();
  useStation(meta?.stationId); // joins the station room for live updates
  const [status, setStatus] = useState('');
  const [items, setItems] = useState([]);
  const [next, setNext] = useState(null);
  const [state, setState] = useState({ loading: true, error: null });

  const load = async (before) => {
    setState({ loading: true, error: null });
    try {
      const q = new URLSearchParams({ limit: '20' });
      if (status) q.set('status', status);
      if (before) q.set('before', before);
      const res = await api.get(`/api/predictions?${q}`);
      setItems((old) => (before ? [...old, ...res.items] : res.items));
      setNext(res.nextBefore);
      setState({ loading: false, error: null });
    } catch (error) {
      setState({ loading: false, error });
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Update rows in place when a request changes; add new ones at the top.
  useEffect(() => {
    const socket = getSocket();
    const onUpdate = (view) =>
      setItems((old) => {
        const i = old.findIndex((x) => x.requestId === view.requestId);
        if (i >= 0) return old.map((x) => (x.requestId === view.requestId ? view : x));
        return !status || status === view.status ? [view, ...old] : old;
      });
    socket.on('prediction:update', onUpdate);
    return () => socket.off('prediction:update', onUpdate);
  }, [status]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Request history</h1>
          <p className="muted">Every charging prediction request sent from this station, newest first.</p>
        </div>
        <Link className="btn" to="/requests/new">
          New request
        </Link>
      </header>

      <div className="filters" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" className={`chip${status === f.value ? ' chip-on' : ''}`} aria-pressed={status === f.value} onClick={() => setStatus(f.value)}>
            {f.label}
          </button>
        ))}
      </div>

      <section className="card">
        <ErrorBox error={state.error} onRetry={() => load()} />
        {!state.loading && !state.error && items.length === 0 && <Empty>No requests match this filter.</Empty>}
        {items.length > 0 && (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Prediction requests</caption>
              <thead>
                <tr>
                  <th scope="col">Sent</th>
                  <th scope="col">Request</th>
                  <th scope="col">Vehicle</th>
                  <th scope="col">SOC</th>
                  <th scope="col">Charger</th>
                  <th scope="col">Status</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Energy</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Result source</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.requestId}>
                    <td>{dateTime(r.createdAt)}</td>
                    <td>
                      <Link to={`/requests/${r.requestId}`}>
                        <code>{shortId(r.requestId)}</code>
                      </Link>
                    </td>
                    <td>{r.input.vehicle.model}</td>
                    <td>
                      {r.input.charging.startSocPct}→{r.input.charging.targetSocPct} %
                    </td>
                    <td>
                      {r.input.charging.chargerType}, {r.input.charging.requestedRateKw} kW
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td>{r.result ? hoursToHm(r.result.predictions.durationHours) : '–'}</td>
                    <td>{r.result ? `${num(r.result.predictions.energyKwh, 1)} kWh` : '–'}</td>
                    <td>{r.result?.predictions.costUsd != null ? `$${num(r.result.predictions.costUsd, 2)}` : '–'}</td>
                    <td>{r.result ? <SourceBadge source={r.result.source || 'ml_estimate'} small /> : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {state.loading && <Loading what="requests" />}
        {next && !state.loading && (
          <button type="button" className="btn" onClick={() => load(next)}>
            Load older
          </button>
        )}
      </section>
    </>
  );
}
