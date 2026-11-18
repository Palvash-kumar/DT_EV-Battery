import { lazy, Suspense, useMemo, useState } from 'react';
import { ChargerTable } from '../components/ChargerTable.jsx';
import { Notice } from '../components/Notice.jsx';
import { Empty, ErrorBox, Loading } from '../components/States.jsx';
import { StatusPill } from '../components/StatusPill.jsx';
import { useMeta } from '../hooks/MetaContext.jsx';
import { useStation } from '../hooks/useStation.js';
import { TelemetryPanel } from '../twin/TelemetryPanel.jsx';
import { hasWebGL, STATUS_COLORS } from '../twin/twinState.js';

// three.js is only downloaded when this page is opened.
const StationScene = lazy(() => import('../twin/StationScene.jsx'));

const LEGEND = [
  ['available', 'Available'],
  ['charging', 'Charging (simulated session)'],
  ['fault', 'Fault / maintenance'],
  ['offline', 'Offline'],
];

export function Twin() {
  const { meta } = useMeta();
  const station = useStation(meta?.stationId);
  const [selected, setSelected] = useState(null);
  const [force2d, setForce2d] = useState(false);
  const webgl = useMemo(() => hasWebGL(), []);
  const show3d = webgl && !force2d;

  if (!meta || (station.loading && !station.data)) return <Loading what="station" />;
  if (station.error && !station.data) return <ErrorBox error={station.error} onRetry={station.reload} />;
  const view = station.data;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Station twin</h1>
          <p className="muted">
            3D view of {view.station.name}. It is drawn from the same backend state as the overview table and updates live.
          </p>
        </div>
        {webgl && (
          <button type="button" className="btn" onClick={() => setForce2d((v) => !v)} aria-pressed={force2d}>
            {force2d ? 'Show 3D view' : 'Show 2D table only'}
          </button>
        )}
      </header>

      {!webgl && (
        <Notice tone="warn" title="3D view not available">
          This browser or computer has no WebGL, so the station is shown as a table instead. All the same information is there.
        </Notice>
      )}

      {view.chargers.length === 0 ? (
        <Empty>
          No chargers in the database. Run <code>npm run db:seed</code> in <code>laptop-1/backend</code>.
        </Empty>
      ) : (
        <>
          <div className={`twin${show3d ? '' : ' twin-2d'}`}>
            {show3d && (
              <div className="twin-canvas" role="img" aria-label={`3D view of ${view.chargers.length} charger bays. The same information is in the bay list and table on this page.`}>
                <Suspense fallback={<Loading what="3D scene" />}>
                  <StationScene view={view} selected={selected} onSelect={setSelected} />
                </Suspense>
                <p className="twin-hint small">Drag to rotate, scroll to zoom, click a charger for details.</p>
              </div>
            )}
            <div className="twin-side">
              <nav aria-label="Charger bays">
                <ul className="bay-buttons">
                  {view.chargers.map((c) => (
                    <li key={c.chargerId}>
                      <button
                        type="button"
                        className={`bay-btn${selected === c.chargerId ? ' bay-btn-on' : ''}`}
                        aria-pressed={selected === c.chargerId}
                        onClick={() => setSelected(selected === c.chargerId ? null : c.chargerId)}
                      >
                        <span>Bay {c.bay}</span>
                        <StatusPill status={c.status} />
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
              <TelemetryPanel view={view} selectedId={selected} />
            </div>
          </div>

          {show3d && (
            <ul className="twin-legend" aria-label="Colour key">
              {LEGEND.map(([status, text]) => (
                <li key={status}>
                  <span className="swatch" style={{ background: STATUS_COLORS[status] }} aria-hidden="true" /> {text}
                </li>
              ))}
            </ul>
          )}

          <section className="card">
            <ChargerTable
              station={view}
              selected={selected}
              onSelect={setSelected}
              onChanged={station.reload}
              caption="Same bays as a table"
            />
            <p className="small muted">
              Charger states are set by an operator or by a simulated session. Moving SOC and charging cars only appear while a simulated
              session is running; the only live hardware value in the project is the ambient temperature from the Arduino (Phase 10).
            </p>
          </section>
        </>
      )}
    </>
  );
}
