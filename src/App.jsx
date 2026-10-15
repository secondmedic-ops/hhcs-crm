import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { initDb, isDemo } from './lib/db.js';
import { AuthProvider, homeFor, NAV, roleAllows, useAuth } from './lib/auth.jsx';
import { ToastProvider, Skeleton } from './components/ui.jsx';
import { CallProvider } from './components/CallCenter.jsx';
import Shell from './components/Shell.jsx';
import Login from './pages/Login.jsx';
import { Terms, Privacy } from './pages/Legal.jsx';

const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const Console = lazy(() => import('./pages/Console.jsx'));
const Cases = lazy(() => import('./pages/Cases.jsx'));
const ProviderFulfilment = lazy(() => import('./pages/ProviderFulfilment.jsx'));
const Leads = lazy(() => import('./pages/Leads.jsx'));
const CaseDetail = lazy(() => import('./pages/CaseDetail.jsx'));
const Callbacks = lazy(() => import('./pages/Callbacks.jsx'));
const Calls = lazy(() => import('./pages/Calls.jsx'));
const Whatsapp = lazy(() => import('./pages/Whatsapp.jsx'));
const Patients = lazy(() => import('./pages/Patients.jsx'));
const PatientDetail = lazy(() => import('./pages/PatientDetail.jsx'));
const Field = lazy(() => import('./pages/Field.jsx'));
const MyVisits = lazy(() => import('./pages/MyVisits.jsx'));
const Approvals = lazy(() => import('./pages/Approvals.jsx'));
const Escalations = lazy(() => import('./pages/Escalations.jsx'));
const Complaints = lazy(() => import('./pages/Complaints.jsx'));
const Mis = lazy(() => import('./pages/Mis.jsx'));
const Audit = lazy(() => import('./pages/Audit.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Find = lazy(() => import('./pages/Find.jsx'));
const Checklist = lazy(() => import('./pages/Checklist.jsx'));
const Invoice = lazy(() => import('./pages/Invoice.jsx'));

function Boot({ children }) {
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState(isDemo ? 'Starting demo database' : 'Connecting');
  const [err, setErr] = useState(null);
  useEffect(() => { initDb(setStep).then(() => setReady(true)).catch((e) => setErr(e.message)); }, []);
  if (ready) return children;
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ width: 360 }}>
        <div className="row mb-12"><div className="brand-mark" style={{ borderColor: 'var(--ink)' }}>HC</div><strong>CareDesk</strong></div>
        {err ? <div className="badge danger" style={{ height: 'auto', padding: 10, whiteSpace: 'normal' }}>{err}</div> : <>
          <Skeleton lines={3} />
          <div className="small muted mt-8">{step}…</div>
        </>}
      </div>
    </div>
  );
}

function Guard({ path, children }) {
  const { profile } = useAuth();
  const item = NAV.find((n) => n.to === path);
  if (item && !roleAllows(item.roles, profile.role)) return <Navigate to={homeFor(profile.role, profile.provider_id)} replace />;
  return children;
}

function Routed() {
  const { profile, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="page"><Skeleton lines={6} /></div>;
  if (!profile) return <Login next={loc.pathname + loc.search} />;
  const g = (path, el) => <Guard path={path}><Suspense fallback={<Skeleton lines={8} />}>{el}</Suspense></Guard>;
  return (
    <CallProvider>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={profile && homeFor(profile.role, profile.provider_id) !== '/' ? <Navigate to={homeFor(profile.role, profile.provider_id)} replace /> : g('/', <Dashboard />)} />
          <Route path="console" element={g('/console', <Console />)} />
          <Route path="fulfilment" element={g('/fulfilment', <ProviderFulfilment />)} />
          <Route path="leads" element={g('/leads', <Leads />)} />
          <Route path="cases" element={g('/cases', <Cases />)} />
          <Route path="cases/:id" element={g('/cases', <CaseDetail />)} />
          <Route path="callbacks" element={g('/callbacks', <Callbacks />)} />
          <Route path="calls" element={g('/calls', <Calls />)} />
          <Route path="whatsapp" element={g('/whatsapp', <Whatsapp />)} />
          <Route path="patients" element={g('/patients', <Patients />)} />
          <Route path="patients/:id" element={g('/patients', <PatientDetail />)} />
          <Route path="field" element={g('/field', <Field />)} />
          <Route path="my-visits" element={g('/my-visits', <MyVisits />)} />
          <Route path="approvals" element={g('/approvals', <Approvals />)} />
          <Route path="escalations" element={g('/escalations', <Escalations />)} />
          <Route path="complaints" element={g('/complaints', <Complaints />)} />
          <Route path="mis" element={g('/mis', <Mis />)} />
          <Route path="audit" element={g('/audit', <Audit />)} />
          <Route path="settings" element={g('/settings', <Settings />)} />
          <Route path="find" element={g('/patients', <Find />)} />
          <Route path="checklist" element={g('/checklist', <Checklist />)} />
          <Route path="invoice" element={g('/cases', <Invoice />)} />
          <Route path="invoice/:id" element={g('/cases', <Invoice />)} />
          <Route path="*" element={<Navigate to={homeFor(profile.role, profile.provider_id)} replace />} />
        </Route>
      </Routes>
    </CallProvider>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/terms" element={<Terms />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="*" element={<Boot><AuthProvider><Routed /></AuthProvider></Boot>} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
