import { Notice } from '../components/Notice.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { useApi } from '../hooks/useApi.js';
import { dateTime, num } from '../lib/format.js';

export function Optimization() {
  const { data, error, loading, reload } = useApi('/api/optimization/plans');

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Optimization</h1>
          <p className="muted">Suggested charger assignments and power split for the station.</p>
        </div>
      </header>

      <Notice tone="warn" title="Advice only">
        Plans here are recommendations that a person has to approve. The project never switches or limits a real charger.
      </Notice>

      <ErrorBox error={error} onRetry={reload} />
      {loading && !data && <Loading what="plans" />}
      {data?.items?.length === 0 && (
        <Empty>
          No plans yet. The optimiser is built in Phase 11; its results will arrive on <code>evdt/v1/results/optimization</code> and show
          up here.
        </Empty>
      )}
      {data?.items?.map((p) => (
        <section key={p.planId} className="card">
          <div className="card-head">
            <h2>Plan from {dateTime(p.generatedAt)}</h2>
            <span className="pill pill-info">{p.approvalStatus}</span>
          </div>
          <p className="small">
            Station limit {num(p.stationLimitKw, 0)} kW · {p.usesSimulatedInputs ? 'uses simulated inputs' : 'no simulated inputs'}
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Charger</th>
                  <th scope="col">Request</th>
                  <th scope="col">Assigned</th>
                  <th scope="col">Expected done</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {p.allocations.map((a) => (
                  <tr key={`${a.chargerId}-${a.requestId}`}>
                    <td>{a.chargerId}</td>
                    <td>
                      <code>{a.requestId?.slice(0, 8)}</code>
                    </td>
                    <td>{num(a.assignedKw, 1)} kW</td>
                    <td>{dateTime(a.predictedCompletionAt)}</td>
                    <td>{a.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}
