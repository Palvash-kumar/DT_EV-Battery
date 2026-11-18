import { useEffect } from 'react';
import { getSocket } from '../api/socket.js';
import { Notice } from '../components/Notice.jsx';
import { SourceBadge } from '../components/SourceBadge.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { useMeta } from '../hooks/MetaContext.jsx';
import { useApi } from '../hooks/useApi.js';
import { dateTime, num } from '../lib/format.js';

// Wording on this page follows docs/battery_model_limitations.md. The labels
// themselves come from the backend so they can't drift.
export function BatteryHealth() {
  const { meta } = useMeta();
  const { data, error, loading, reload } = useApi('/api/battery-health');

  useEffect(() => {
    const socket = getSocket();
    socket.on('health:update', reload);
    return () => socket.off('health:update', reload);
  }, [reload]);

  if (loading && !data) return <Loading what="battery health" />;
  if (error && !data) return <ErrorBox error={error} onRetry={reload} />;

  const latest = data.estimates.find((e) => e.status === 'completed');
  const soh = meta?.models?.soh;
  const rul = meta?.models?.rul;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Battery health</h1>
          <p className="muted">State of health (SOH) and remaining useful life (RUL), estimated by models trained on battery aging data.</p>
        </div>
      </header>

      <Notice tone="warn" title="Estimates from lab aging data, not measurements of a car">
        <p>
          These numbers come from a model trained on <strong>{data.domain.chemistry}</strong> cells. The aging data is{' '}
          {data.domain.dataset.toLowerCase()}. No vehicle BMS is connected, so nothing on this page is measured from an EV battery.
        </p>
      </Notice>

      {latest ? (
        <div className="grid stats">
          <section className="card stat">
            <h3>State of health</h3>
            <p className="stat-value">
              {num(latest.sohPct, 1)} <span className="unit">%</span>
            </p>
            <p className="small">{latest.sohLabel}</p>
            <SourceBadge source={latest.source} isDemo={latest.isDemo} />
          </section>
          <section className="card stat">
            <h3>Remaining useful life</h3>
            <p className="stat-value">
              {latest.rulCycles === null ? '–' : num(latest.rulCycles, 0)} <span className="unit">cycles</span>
            </p>
            <p className="small">{latest.rulLabel}</p>
            <p className="small">
              Cycles until SOH falls below <strong>{num(latest.eolThresholdSohPct, 0)} %</strong>. That threshold is a configurable
              assumption, not a physical limit.
            </p>
          </section>
          <section className="card stat">
            <h3>Capacity loss</h3>
            <p className="stat-value">
              {num(latest.capacityLossAh, 2)} <span className="unit">Ah</span>
            </p>
            <p className="small">Relative to the lab cell's starting capacity.</p>
            <p className="small muted">Estimated {dateTime(latest.processedAt)}</p>
          </section>
        </div>
      ) : (
        <Empty>No health estimates have been received on <code>evdt/v1/results/health</code> yet.</Empty>
      )}

      {latest?.isDemo && (
        <Notice title="This record is demo data">
          It was copied from <code>shared/schemas/examples/health-result.json</code> by the seed script so this page has something to
          show. It was not produced by the model.
        </Notice>
      )}

      <section className="card">
        <h2>All estimates</h2>
        {data.estimates.length === 0 ? (
          <Empty>None yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Battery health estimates, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Estimated</th>
                  <th scope="col">SOH (%)</th>
                  <th scope="col">RUL (cycles)</th>
                  <th scope="col">Threshold</th>
                  <th scope="col">Capacity loss (Ah)</th>
                  <th scope="col">Models</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {data.estimates.map((e) => (
                  <tr key={e.healthEstimateId}>
                    <td>{dateTime(e.processedAt)}</td>
                    <td>{num(e.sohPct, 1)}</td>
                    <td>{e.rulCycles === null ? '–' : num(e.rulCycles, 0)}</td>
                    <td>{num(e.eolThresholdSohPct, 0)} %</td>
                    <td>{num(e.capacityLossAh, 2)}</td>
                    <td className="small">
                      SOH {e.model?.sohVersion || '–'} · RUL {e.model?.rulVersion || '–'}
                    </td>
                    <td>
                      <SourceBadge source={e.source} isDemo={e.isDemo} small />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid two">
        <section className="card">
          <h2>Applicability</h2>
          <ul>
            {(latest?.applicabilityNotes?.length ? latest.applicabilityNotes : data.notes).map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {(soh || rul) && (
            <>
              <h3>Model accuracy on held-out batteries</h3>
              <ul>
                {soh && (
                  <li>
                    SOH: {soh.selectedModel}, MAE {num(soh.testMae, 2)} percentage points, R² {num(soh.testR2, 3)}
                    {soh.testBatteries ? ` (test batteries ${soh.testBatteries.join(', ')})` : ''}.
                  </li>
                )}
                {rul && (
                  <li>
                    RUL: {rul.selectedModel}, MAE {num(rul.testMae, 1)} cycles, R² {num(rul.testR2, 3)}.
                  </li>
                )}
              </ul>
              <p className="small">
                These scores are measured on synthetic curves from the same generator the model was trained on, so they say how well the
                model learned that generator, not how well it would do on a real battery.
              </p>
            </>
          )}
        </section>
        <section className="card">
          <h2>What this page does not claim</h2>
          <ul className="not-claimed">
            {data.notClaimed.map((c) => (
              <li key={c}>
                <span aria-hidden="true">✕</span> “{c}”
              </li>
            ))}
          </ul>
          <p className="small">Turning these into real claims would need BMS data from real vehicles to calibrate against.</p>
        </section>
      </div>
    </>
  );
}
