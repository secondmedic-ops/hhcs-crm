import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { initDb, isDemo } from './lib/db.js';
import { AuthProvider, homeFor, NAV, roleAllows, useAuth } from './lib/auth.jsx';
import { ToastProvider, Skeleton } from './components/ui.jsx';
import { CallProvider } from './components/CallCenter.jsx';
import Shell from './components/Shell.jsx';
import Login from './pages/Login.jsx';
import { Terms, Privacy } from './pages/Legal.jsx';

export const routeLoaders = {
  '/': () => import('./pages/Dashboard.jsx'),
  '/console': () => import('./pages/Console.jsx'),
  '/cases': () => import('./pages/Cases.jsx'),
  'cases-detail': () => import('./pages/CaseDetail.jsx'),
  '/fulfilment': () => import('./pages/ProviderFulfilment.jsx'),
  '/leads': () => import('./pages/Leads.jsx'),
  '/callbacks': () => import('./pages/Callbacks.jsx'),
  '/calls': () => import('./pages/Calls.jsx'),
  '/whatsapp': () => import('./pages/Whatsapp.jsx'),
  '/email': () => import('./pages/Email.jsx'),
  '/feedback-list': () => import('./pages/Feedback.jsx'),
  '/patients': () => import('./pages/Patients.jsx'),
  'patients-detail': () => import('./pages/PatientDetail.jsx'),
  '/field': () => import('./pages/Field.jsx'),
  '/my-visits': () => import('./pages/MyVisits.jsx'),
  '/approvals': () => import('./pages/Approvals.jsx'),
  '/escalations': () => import('./pages/Escalations.jsx'),
  '/complaints': () => import('./pages/Complaints.jsx'),
  '/mis': () => import('./pages/Mis.jsx'),
  '/audit': () => import('./pages/Audit.jsx'),
  '/settings': () => import('./pages/Settings.jsx'),
  '/find': () => import('./pages/Find.jsx'),
  '/checklist': () => import('./pages/Checklist.jsx'),
  '/knowledge': () => import('./pages/Knowledge.jsx'),
  '/invoice': () => import('./pages/Invoice.jsx'),
  '/bmm': () => import('./pages/BmmWorkspace.jsx'),
};

export function preloadRoute(path) {
  if (!path) return;
  const p = path.split('?')[0].split('#')[0];
  const loader = routeLoaders[p]
    || (p.startsWith('/cases/') ? routeLoaders['cases-detail'] : null)
    || (p.startsWith('/patients/') ? routeLoaders['patients-detail'] : null)
    || (p.startsWith('/invoice/') ? routeLoaders['/invoice'] : null);
  if (loader) loader();
}

const Dashboard = lazy(routeLoaders['/']);
const Console = lazy(routeLoaders['/console']);
const Cases = lazy(routeLoaders['/cases']);
const ProviderFulfilment = lazy(routeLoaders['/fulfilment']);
const Leads = lazy(routeLoaders['/leads']);
const CaseDetail = lazy(routeLoaders['cases-detail']);
const Callbacks = lazy(routeLoaders['/callbacks']);
const Calls = lazy(routeLoaders['/calls']);
const Whatsapp = lazy(routeLoaders['/whatsapp']);
const Patients = lazy(routeLoaders['/patients']);
const PatientDetail = lazy(routeLoaders['patients-detail']);
const Field = lazy(routeLoaders['/field']);
const MyVisits = lazy(routeLoaders['/my-visits']);
const Approvals = lazy(routeLoaders['/approvals']);
const Escalations = lazy(routeLoaders['/escalations']);
const Complaints = lazy(routeLoaders['/complaints']);
const Mis = lazy(routeLoaders['/mis']);
const Audit = lazy(routeLoaders['/audit']);
const Settings = lazy(routeLoaders['/settings']);
const Find = lazy(routeLoaders['/find']);
const Checklist = lazy(routeLoaders['/checklist']);
const Invoice = lazy(routeLoaders['/invoice']);
const Knowledge = lazy(routeLoaders['/knowledge']);
const BmmWorkspace = lazy(routeLoaders['/bmm']);
const Email = lazy(routeLoaders['/email']);
const Feedback = lazy(routeLoaders['/feedback-list']);
const PublicFeedback = lazy(() => import('./pages/PublicFeedback.jsx'));

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
  if (item && (!roleAllows(item.roles, profile.role) || (item.when && !item.when(profile)))) return <Navigate to={homeFor(profile.role, profile.provider_id)} replace />;
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
          <Route path="bmm" element={g('/bmm', <BmmWorkspace />)} />
          <Route path="fulfilment" element={g('/fulfilment', <ProviderFulfilment />)} />
          <Route path="leads" element={g('/leads', <Leads />)} />
          <Route path="cases" element={g('/cases', <Cases />)} />
          <Route path="cases/:id" element={g('/cases', <CaseDetail />)} />
          <Route path="callbacks" element={g('/callbacks', <Callbacks />)} />
          <Route path="calls" element={g('/calls', <Calls />)} />
          <Route path="whatsapp" element={g('/whatsapp', <Whatsapp />)} />
          <Route path="email" element={g('/email', <Email />)} />
          <Route path="feedback-list" element={g('/feedback-list', <Feedback />)} />
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
          <Route path="knowledge" element={g('/knowledge', <Knowledge />)} />
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
          <Route path="/feedback" element={<Suspense fallback={<Skeleton lines={5} />}><PublicFeedback /></Suspense>} />
          <Route path="*" element={<Boot><AuthProvider><Routed /></AuthProvider></Boot>} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}
