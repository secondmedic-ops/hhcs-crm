import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isDemo, isLocal } from '../lib/db.js';
import { homeFor, useAuth } from '../lib/auth.jsx';
import { ROLE_LABEL } from '../lib/fmt.js';
import { DEMO_USERS } from '../demo/seed.js';
import { Button, Field, Input, ErrorNote } from '../components/ui.jsx';

const DEMO_PICKS = ['agent', 'coordinator', 'supervisor', 'client_manager', 'client_clinical', 'field_staff', 'medical_desk', 'provider', 'admin'];

export default function Login({ next }) {
  const { signIn, signInDemo, mfa, noProfile, verifyMfa, signOut, retry } = useAuth();
  const [code, setCode] = useState('');
  const idle = (() => { try { const v = sessionStorage.getItem('caredesk.idle'); sessionStorage.removeItem('caredesk.idle'); return v; } catch { return null; } })();
  const [idleNote] = useState(idle);
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Deep links (a case, a lead) are kept after login; general pages are not, so each role starts on its own home
  // page (agents: console, providers: leads, management: dashboard) instead of e.g. Settings.
  const after = () => (next && /^\/(cases|patients|leads|approvals|escalations|complaints|callbacks)\/./.test(next) ? next : '/');
  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await signIn(email, password); nav(after(), { replace: true }); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };
  const submitCode = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await verifyMfa(code); nav(after(), { replace: true }); }
    catch (e2) { setErr(e2.message); setCode(''); } finally { setBusy(false); }
  };
  const demo = async (u) => { await signInDemo(u.id); nav(homeFor(u.role)); };

  return (
    <div className="login">
      <div className="login-side">
        <div className="row"><div className="brand-mark">HC</div><strong>Hinduja Home Care · CareDesk</strong></div>
        <div>
          <h1 style={{ fontSize: 28, lineHeight: 1.2, color: '#fff', maxWidth: 440 }}>Every interaction captured. Every price approved. Every case traceable from enquiry to closure.</h1>
          <div className="col mt-24" style={{ gap: 10, color: 'var(--side-muted)', maxWidth: 440 }}>
            <span>Case IDs with stage gates, recorded calls on one patient timeline, locked rate card with in-app discount approval, live SLA timers and three-level escalation.</span>
            <span>Hinduja is the Data Fiduciary and owner of all records. SecondMedic operates the service as Data Processor.</span>
          </div>
        </div>
        <div className="tiny" style={{ color: 'var(--side-muted)' }}>Data hosted in India · Encrypted in transit and at rest · <a href="/privacy" style={{ color: 'inherit' }}>Privacy</a> · <a href="/terms" style={{ color: 'inherit' }}>Terms</a></div>
      </div>
      <div className="login-main">
        <div className="login-card">
          {isDemo || isLocal ? (
            <>
              <h1>{isLocal ? 'Local test' : 'Open the demo'}</h1>
              <p className="muted mt-4 mb-16">Pick a role. Each one sees exactly what the role matrix allows · try the agent and Hinduja management side by side in two browser windows.</p>
              <div className="panel">
                {DEMO_PICKS.map((role) => {
                  const u = DEMO_USERS.find((x) => x.role === role);
                  return (
                    <button key={role} className="list-row click" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line-2)', font: 'inherit', textAlign: 'left' }} onClick={() => demo(u)}>
                      <div className="grow">
                        <div className="strong">{ROLE_LABEL[role]}</div>
                        <div className="small muted">{u.full_name}{u.agent_code ? ` · ${u.agent_code}` : ''}</div>
                      </div>
                      <span className="small muted">Sign in</span>
                    </button>
                  );
                })}
              </div>
              <p className="tiny faint mt-12">{isLocal
                ? 'Local test: the real API on this computer with a throw-away test database (RUN-LOCAL-TEST.bat). Login is off here; the live site always asks for a Supabase login.'
                : 'Demo mode runs a private database inside this browser. The live site uses Supabase login and the Cloudflare API.'}</p>
            </>
          ) : noProfile ? (
            <div className="col gap-12">
              <h1>No access yet</h1>
              {noProfile === true
                ? <p className="muted">You are signed in, but this login has no CareDesk profile. Ask the platform administrator to add you in Settings, Users, with your role.</p>
                : <><p className="muted">You are signed in, but your CareDesk profile could not be loaded. The server said:</p>
                  <div className="badge danger" style={{ height: 'auto', padding: 10, whiteSpace: 'normal' }}>{String(noProfile)}</div></>}
              <Button kind="primary" onClick={retry}>Try again</Button>
              <Button onClick={signOut}>Sign out</Button>
            </div>
          ) : mfa ? (
            <form onSubmit={submitCode} className="col gap-12">
              <h1>Two-factor check</h1>
              <p className="muted">Enter the 6-digit code from your authenticator app.</p>
              <Field label="Code"><Input className="mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus required /></Field>
              <ErrorNote error={err} />
              <Button kind="primary" size="lg" type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Verify'}</Button>
              <button type="button" className="linklike small" onClick={signOut}>Use a different account</button>
            </form>
          ) : (
            <form onSubmit={submit} className="col gap-12">
              {idleNote && <div className="badge info" style={{ height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }}>You were signed out after a period of inactivity.</div>}
              <h1>Sign in</h1>
              <p className="muted">Use the account issued by your administrator.</p>
              <Field label="Work email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
              <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
              <ErrorNote error={err} />
              <Button kind="primary" size="lg" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
              <p className="tiny faint">Access is logged. Multi-factor authentication can be enabled under Settings → Security.</p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
