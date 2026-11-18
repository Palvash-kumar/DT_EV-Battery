import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { getSocket } from '../api/socket.js';
import { Notice } from '../components/Notice.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { useApi } from '../hooks/useApi.js';
import { ago, dateTime } from '../lib/format.js';

const FILTERS = ['open', 'acknowledged', 'resolved', ''];

function AlertActions({ alert, onDone }) {
  const [error, setError] = useState(null);
  const act = async (status) => {
    setError(null);
    try {
      await api.patch(`/api/alerts/${alert.alertId}`, { status });
      onDone();
    } catch (err) {
      setError(err.message);
    }
  };
  if (alert.status === 'resolved') return null;
  return (
    <div className="actions">
      {alert.status === 'open' && (
        <button type="button" className="btn btn-small" onClick={() => act('acknowledged')}>
          Acknowledge
        </button>
      )}
      <button type="button" className="btn btn-small" onClick={() => act('resolved')}>
        Resolve
      </button>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

export function Alerts() {
  const [status, setStatus] = useState('open');
  const { data, error, loading, reload } = useApi(`/api/alerts?limit=100${status ? `&status=${status}` : ''}`);

  useEffect(() => {
    const socket = getSocket();
    socket.on('alert:update', reload);
    return () => socket.off('alert:update', reload);
  }, [reload]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Alerts</h1>
          <p className="muted">Raised by services on <code>evdt/v1/alerts</code>. Repeats of the same alert are counted, not listed again.</p>
        </div>
      </header>

      <Notice title="An alert is a reason to look, not a diagnosis">
        An alert means a rule or an anomaly score crossed a threshold. It is not a confirmed hardware fault, especially when the input
        was simulated.
      </Notice>

      <div className="filters" role="group" aria-label="Filter by status">
        {FILTERS.map((f) => (
          <button key={f || 'all'} type="button" className={`chip${status === f ? ' chip-on' : ''}`} aria-pressed={status === f} onClick={() => setStatus(f)}>
            {f ? f[0].toUpperCase() + f.slice(1) : 'All'}
          </button>
        ))}
      </div>

      <ErrorBox error={error} onRetry={reload} />
      {loading && !data && <Loading what="alerts" />}
      {data?.items?.length === 0 && <Empty>No {status || ''} alerts.</Empty>}

      <ul className="alert-list">
        {data?.items?.map((a) => (
          <li key={a.alertId} className={`card alert alert-${a.severity}`}>
            <div className="card-head">
              <h2>
                <StatusPill status={a.severity} /> {a.type.replaceAll('_', ' ')}
              </h2>
              <StatusPill status={a.status} />
            </div>
            <dl className="facts">
              <dt>Affected</dt>
              <dd>{a.affectedAsset || '–'}</dd>
              <dt>Raised by</dt>
              <dd>{a.raisedBy}</dd>
              <dt>Seen</dt>
              <dd>
                {a.occurrences}× · first {dateTime(a.firstSeenAt)} · last {ago(a.lastSeenAt)}
              </dd>
              {a.recommendedAction && (
                <>
                  <dt>Suggested check</dt>
                  <dd>{a.recommendedAction}</dd>
                </>
              )}
              {a.evidence && Object.keys(a.evidence).length > 0 && (
                <>
                  <dt>Evidence</dt>
                  <dd>
                    <code>{JSON.stringify(a.evidence)}</code>
                  </dd>
                </>
              )}
            </dl>
            <AlertActions alert={a} onDone={reload} />
            {a.statusHistory?.length > 1 && (
              <details>
                <summary>History</summary>
                <ul className="small">
                  {a.statusHistory.map((h, i) => (
                    <li key={i}>
                      {dateTime(h.at)} — {h.status} by {h.by}
                      {h.note ? ` (${h.note})` : ''}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
