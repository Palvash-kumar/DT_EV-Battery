import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { getSocket, joinRoom } from '../api/socket.js';
import { Lifecycle } from '../components/Lifecycle.jsx';
import { Notice } from '../components/Notice.jsx';
import { SourceBadge } from '../components/SourceBadge.jsx';
import { ErrorBox, Loading } from '../components/States.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { useMeta } from '../hooks/MetaContext.jsx';
import { useApi } from '../hooks/useApi.js';
import { useStation } from '../hooks/useStation.js';
import { dateTime, hoursToHm, num } from '../lib/format.js';

const ERROR_TEXT = {
  BROKER_UNAVAILABLE: 'The MQTT broker on Laptop 2 could not be reached, so the request never left Laptop 1.',
  SCHEMA_INVALID: 'The ML worker rejected the request format.',
  BUSINESS_RULE: 'The ML worker rejected the values.',
  INTERNAL_ERROR: 'The ML worker failed while predicting.',
};

function useCountdown(sentAt, timeoutSec, active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [active]);
  if (!active || !sentAt) return null;
  return Math.max(0, Math.ceil(timeoutSec - (now - new Date(sentAt).getTime()) / 1000));
}

function ModelCard({ name, card }) {
  if (!card) return null;
  if (card.selectedModel === 'PhysicsEstimate') {
    return (
      <li>
        <strong>{name}</strong>: physics estimate. The best model trained on the CSV ({card.bestMlModel}) scored a cross-validated R² of{' '}
        {num(card.bestMlCvR2, 2)}, and the permutation test (p = {num(card.permutationPValue, 2)}){' '}
        {card.hasUsefulSignal ? 'found a usable pattern' : 'found no usable pattern in that column'}.
      </li>
    );
  }
  return (
    <li>
      <strong>{name}</strong>: {card.selectedModel}, trained {card.version}. On {card.testRows} held-out sessions the average error
      (MAE) was {num(card.testMae, 2)} {card.units}, R² {num(card.testR2, 2)}.
    </li>
  );
}

function StartSession({ request, onStarted }) {
  const { meta } = useMeta();
  const station = useStation(request.stationId);
  const [bay, setBay] = useState(request.chargerId || '');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const options = (station.data?.chargers || []).filter((c) => c.chargerType === request.input.charging.chargerType);
  const chosen = options.find((c) => c.chargerId === bay);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/sessions/simulated', { requestId: request.requestId, chargerId: bay || undefined });
      onStarted();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Play it on a bay</h2>
      <p className="small">
        Starts a <strong>simulated</strong> session that uses the predicted duration as its clock, sped up {meta?.simTimeScale}×. The bay
        shows as charging on the overview and in the 3D view. No real charger is switched.
      </p>
      <div className="inline-form">
        <label htmlFor="bay">Bay</label>
        <select id="bay" value={bay} onChange={(e) => setBay(e.target.value)}>
          <option value="">Choose a {request.input.charging.chargerType} bay</option>
          {options.map((c) => (
            <option key={c.chargerId} value={c.chargerId} disabled={c.status !== 'available'}>
              Bay {c.bay} · {c.maxPowerKw} kW · {c.status}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary" onClick={start} disabled={busy || !chosen || chosen.status !== 'available'}>
          Start simulated session
        </button>
      </div>
      <ErrorBox error={error} />
    </section>
  );
}

export function RequestDetail() {
  const { requestId } = useParams();
  const navigate = useNavigate();
  const { meta } = useMeta();
  const { data: r, error, loading, setData, reload } = useApi(`/api/predictions/${requestId}`);
  const [retryError, setRetryError] = useState(null);

  // Live updates for this request; polling as a fallback while it is pending.
  useEffect(() => {
    const socket = getSocket();
    const leave = joinRoom({ requestId });
    const onUpdate = (view) => view.requestId === requestId && reload();
    socket.on('prediction:update', onUpdate);
    return () => {
      leave();
      socket.off('prediction:update', onUpdate);
    };
  }, [requestId, reload]);

  const pending = r?.status === 'pending';
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(reload, 3000);
    return () => clearInterval(t);
  }, [pending, reload]);

  const timeoutSec = meta?.requestTimeoutSec ?? 15;
  const left = useCountdown(r?.sentAt, timeoutSec, pending);

  if (loading && !r) return <Loading what="request" />;
  if (error && !r) return <ErrorBox error={error} onRetry={reload} />;

  const retryable = r.status === 'timed_out' || (r.status === 'failed' && r.error?.code === 'BROKER_UNAVAILABLE');
  const retry = async () => {
    setRetryError(null);
    try {
      setData(await api.post(`/api/predictions/${r.requestId}/retry`));
    } catch (err) {
      setRetryError(err);
    }
  };

  const { vehicle, charging, environment } = r.input;
  const pred = r.result?.predictions;
  const resultSource = r.result?.source || 'ml_estimate';
  const isStub = resultSource === 'simulation';
  const latencyMs = r.result ? new Date(r.result.receivedAt) - new Date(r.sentAt) : null;
  const reference = (vehicle.batteryCapacityKwh * (charging.targetSocPct - charging.startSocPct)) / 100;

  const lifecycleDetail = {
    pending: left !== null ? `waiting for Laptop 2, times out in ${left} s` : 'waiting for Laptop 2',
    completed: r.result?.lateResult ? 'result arrived after the timeout and was still kept' : `result received${latencyMs ? ` in ${latencyMs} ms` : ''}`,
    timed_out: `no result within ${timeoutSec} s`,
    failed: r.error ? ERROR_TEXT[r.error.code] || r.error.message : '',
  }[r.status];

  return (
    <>
      <header className="page-head">
        <div>
          <p className="crumbs">
            <Link to="/requests">Request history</Link> /
          </p>
          <h1>Charging prediction</h1>
          <p className="muted">
            Request <code>{r.requestId}</code>
          </p>
        </div>
        <StatusPill status={r.status} />
      </header>

      <Lifecycle stage={r.status} detail={lifecycleDetail} />

      {r.status === 'failed' && r.error && (
        <div className="state state-error" role="alert">
          <strong>{r.error.code}</strong>: {r.error.message}
        </div>
      )}
      {retryable && (
        <div className="card retry">
          <p>
            {r.status === 'timed_out'
              ? 'Laptop 2 did not answer in time. Retrying sends the same request id again; if the worker already has a result for it, it just sends that back.'
              : 'Retry once the broker is back.'}
          </p>
          <button type="button" className="btn btn-primary" onClick={retry}>
            Retry request
          </button>
          <ErrorBox error={retryError} />
        </div>
      )}

      {pred && (
        <section className="card result">
          <div className="card-head">
            <h2>Result</h2>
            <SourceBadge source={resultSource} />
          </div>
          {isStub && (
            <Notice tone="warn" title="Not from the ML model">
              This came from the development stub worker (simple formula). It only exists to test the dashboard without Laptop 2.
            </Notice>
          )}
          <div className="grid result-grid">
            <div className="big-number">
              <p className="big-label">Estimated charging duration</p>
              <p className="big-value">{hoursToHm(pred.durationHours)}</p>
              <p className="small muted">{num(pred.durationHours, 2)} h</p>
            </div>
            <div className="big-number">
              <p className="big-label">Estimated energy delivered</p>
              <p className="big-value">
                {num(pred.energyKwh, 1)} <span className="unit">kWh</span>
              </p>
              <p className="small muted">
                Simple reference: {num(reference, 1)} kWh ({vehicle.batteryCapacityKwh} kWh × {charging.targetSocPct - charging.startSocPct} %),
                not a model
              </p>
            </div>
            {pred.costUsd != null && (
              <div className="big-number">
                <p className="big-label">Estimated charging cost</p>
                <p className="big-value">
                  <span className="unit">$</span>
                  {num(pred.costUsd, 2)}
                </p>
                <p className="small muted">
                  {String(r.result.model?.costVersion || '').startsWith('physics')
                    ? 'Grid energy × typical DC fast-charging price'
                    : 'Model trained on real Palo Alto charging fees'}
                </p>
              </div>
            )}
            {pred.wearFactor != null && (
              <div className="big-number">
                <p className="big-label">Battery wear from this charge</p>
                <p className="big-value">
                  {num(pred.wearFactor, 2)}× <span className="unit">gentle charge</span>
                </p>
                <p className="small muted">≈ {num(pred.batteryWearPct, 4)} percentage points of SOH (lab-data stress model)</p>
              </div>
            )}
            {pred.estimatedSohPct != null && (
              <div className="big-number">
                <p className="big-label">Estimated battery health</p>
                <p className="big-value">
                  {num(pred.estimatedSohPct, 1)} <span className="unit">% SOH</span>
                </p>
                <p className="small muted">
                  Usable capacity ≈ {num((vehicle.batteryCapacityKwh * pred.estimatedSohPct) / 100, 1)} kWh at {vehicle.vehicleAgeYears} years old
                </p>
              </div>
            )}
          </div>
          <dl className="facts">
            <dt>Duration model</dt>
            <dd>{r.result.model?.durationVersion || '–'}</dd>
            <dt>Energy model</dt>
            <dd>{r.result.model?.energyVersion || '–'}</dd>
            <dt>Cost model</dt>
            <dd>{r.result.model?.costVersion || '–'}</dd>
            <dt>Wear model</dt>
            <dd>{r.result.model?.wearVersion || '–'}</dd>
            <dt>Predicted at (Laptop 2)</dt>
            <dd>{dateTime(r.result.processedAt)}</dd>
            <dt>Received (Laptop 1)</dt>
            <dd>{dateTime(r.result.receivedAt)}</dd>
            <dt>Round trip</dt>
            <dd>{latencyMs !== null ? `${latencyMs} ms` : '–'}</dd>
            <dt>Attempts</dt>
            <dd>{r.attempts}</dd>
          </dl>
          {r.result.warnings?.length > 0 && (
            <>
              <h3>Warnings from the worker</h3>
              <ul className="warnings">
                {r.result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </>
          )}
          {!isStub && meta?.models && (
            <Notice title="How far to trust these numbers">
              <ul>
                <ModelCard name="Duration" card={meta.models.duration} />
                <ModelCard name="Energy" card={meta.models.energy} />
                <ModelCard name="Cost" card={meta.models.cost} />
              </ul>
              <p>
                Level 1/2 duration and cost come from models trained on about 250,000 real Palo Alto charging sessions and scored on
                drivers they never saw. DC fast charging has no public session data, so it uses the physics estimator. Energy is
                calculated from the battery size, the charge window and charging losses. These are estimates, not measurements of a real
                car.
              </p>
            </Notice>
          )}
        </section>
      )}

      {r.status === 'completed' && <StartSession request={r} onStarted={() => navigate('/')} />}

      <section className="card">
        <h2>Input</h2>
        <dl className="facts">
          <dt>Vehicle</dt>
          <dd>
            {vehicle.model}, {vehicle.batteryCapacityKwh} kWh, {vehicle.vehicleAgeYears} years old
          </dd>
          <dt>State of charge</dt>
          <dd>
            {charging.startSocPct} % → {charging.targetSocPct} %
          </dd>
          <dt>Charger</dt>
          <dd>
            {charging.chargerType}, {charging.requestedRateKw} kW requested{r.chargerId ? ` · ${r.chargerId}` : ''}
          </dd>
          <dt>Ambient temperature</dt>
          <dd>
            {environment.temperatureC} °C <SourceBadge source={environment.source} small />
          </dd>
          <dt>Station</dt>
          <dd>{r.stationId}</dd>
        </dl>
      </section>

      <section className="card">
        <h2>Audit trail</h2>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Status history for this request</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Status</th>
                <th scope="col">What happened</th>
                <th scope="col">MQTT message</th>
              </tr>
            </thead>
            <tbody>
              {(r.statusHistory || []).map((h, i) => (
                <tr key={`${h.at}-${i}`}>
                  <td>{dateTime(h.at)}</td>
                  <td>
                    <StatusPill status={h.status} />
                  </td>
                  <td>{h.note}</td>
                  <td>{h.messageId ? <code title={h.messageId}>{h.messageId.slice(0, 8)}</code> : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
