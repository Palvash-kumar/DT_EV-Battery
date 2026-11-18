import { BrowserRouter, Link, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.jsx';
import { MetaProvider } from './hooks/MetaContext.jsx';
import { Alerts } from './pages/Alerts.jsx';
import { BatteryHealth } from './pages/BatteryHealth.jsx';
import { NewRequest } from './pages/NewRequest.jsx';
import { Optimization } from './pages/Optimization.jsx';
import { Overview } from './pages/Overview.jsx';
import { Provenance } from './pages/Provenance.jsx';
import { RequestDetail } from './pages/RequestDetail.jsx';
import { RequestHistory } from './pages/RequestHistory.jsx';
import { Telemetry } from './pages/Telemetry.jsx';
import { Twin } from './pages/Twin.jsx';

function NotFound() {
  return (
    <>
      <h1>Page not found</h1>
      <p>
        <Link to="/">Back to the overview</Link>
      </p>
    </>
  );
}

export function App() {
  return (
    <MetaProvider>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Overview />} />
            <Route path="twin" element={<Twin />} />
            <Route path="requests" element={<RequestHistory />} />
            <Route path="requests/new" element={<NewRequest />} />
            <Route path="requests/:requestId" element={<RequestDetail />} />
            <Route path="battery" element={<BatteryHealth />} />
            <Route path="telemetry" element={<Telemetry />} />
            <Route path="alerts" element={<Alerts />} />
            <Route path="optimization" element={<Optimization />} />
            <Route path="provenance" element={<Provenance />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </MetaProvider>
  );
}
