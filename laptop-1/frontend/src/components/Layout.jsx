import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { useMeta } from '../hooks/MetaContext.jsx';
import { useServiceStatus } from '../hooks/useServiceStatus.js';
import { ago } from '../lib/format.js';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/twin', label: 'Station twin (3D)' },
  { to: '/requests/new', label: 'New request' },
  { to: '/requests', label: 'Request history', end: true },
  { to: '/battery', label: 'Battery health' },
  { to: '/telemetry', label: 'Telemetry' },
  { to: '/alerts', label: 'Alerts' },
  { to: '/optimization', label: 'Optimization' },
  { to: '/provenance', label: 'Data provenance' },
];

function Dot({ ok, label, detail }) {
  const state = ok === null ? 'unknown' : ok ? 'up' : 'down';
  return (
    <li className={`svc svc-${state}`} title={detail}>
      <span aria-hidden="true" className="svc-dot" />
      {label}: <strong>{state === 'up' ? 'connected' : state === 'down' ? 'down' : 'checking'}</strong>
    </li>
  );
}

export function Layout() {
  const { meta } = useMeta();
  const { health, backendUp, socketUp } = useServiceStatus();
  const worker = health?.mlWorker;
  const location = useLocation();

  return (
    <div className="app">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ⌁
          </span>
          <div>
            <p className="brand-name">EV Station Twin</p>
            <p className="brand-sub">{meta?.stationId || '…'} · Laptop 1</p>
          </div>
        </div>
        <ul className="services" aria-label="Service status">
          <Dot ok={backendUp} label="Backend" />
          <Dot ok={backendUp ? Boolean(health?.mqtt?.connected) : backendUp} label="MQTT broker" detail={health?.mqtt?.broker} />
          <Dot ok={backendUp ? health?.mongo?.state === 'connected' : backendUp} label="MongoDB" />
          <Dot ok={backendUp === false ? false : socketUp} label="Live updates" />
          <li className="svc svc-info">
            ML worker last result: <strong>{ago(worker?.lastResultAt)}</strong>
            {worker?.lastOfflineNoticeAt &&
              (!worker.lastResultAt || worker.lastOfflineNoticeAt > worker.lastResultAt) && (
                <span className="svc-warn"> (reported offline {ago(worker.lastOfflineNoticeAt)})</span>
              )}
          </li>
        </ul>
      </header>

      <nav className="sidenav" aria-label="Pages">
        <ul>
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} end={n.end}>
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      <main id="main" className="content" tabIndex={-1}>
        <ErrorBoundary resetKey={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
