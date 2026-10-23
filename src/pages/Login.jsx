import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, isDemo, isLocal, q } from '../lib/db.js';
import { homeFor, useAuth } from '../lib/auth.jsx';
import { ROLE_LABEL, DEPARTMENTS } from '../lib/fmt.js';
import { DEMO_USERS } from '../demo/seed.js';
import { Button, Field, Input, ErrorNote, Badge } from '../components/ui.jsx';

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

  const [authMode, setAuthMode] = useState(isDemo || isLocal ? 'dept' : 'password');
  const [dept, setDept] = useState('agent');
  const [find, setFind] = useState('');
  const [staffList, setStaffList] = useState(DEMO_USERS);
  const [mobilePhone, setMobilePhone] = useState('');
  const [mobileOtp, setMobileOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpSuccessNote, setOtpSuccessNote] = useState('');

  // Attempt to load live profiles if available, blending with DEMO_USERS for complete metadata
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (db && (isDemo || isLocal)) {
          const res = await q(
            db.from('profiles')
              .select('id,full_name,email,phone,role,agent_code,myoperator_user_id,myoperator_extension,zone_id,skills,provider_id,active')
              .order('full_name')
          );
          if (mounted && Array.isArray(res) && res.length > 0) {
            // Blend DB profiles with DEMO_USERS so extra fields (skills, codes) are preserved
            const blended = res.map((u) => {
              const demo = DEMO_USERS.find((d) => d.id === u.id || d.email === u.email);
              return demo ? { ...demo, ...u } : u;
            });
            // Also append any DEMO_USERS not in DB so all departments remain fully testable
            const ids = new Set(blended.map((x) => x.id));
            const all = [...blended, ...DEMO_USERS.filter((d) => !ids.has(d.id))];
            setStaffList(all);
          }
        }
      } catch {
        // Fallback to DEMO_USERS
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Deep links (a case, a lead) are kept after login; general pages use role home
  const after = (role) => (next && /^\/((cases|patients|leads|approvals|escalations|complaints|callbacks)\/.|find\?)/.test(next) ? next : homeFor(role));

  const submit = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await signIn(email, password); nav(after('supervisor'), { replace: true }); }
    catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  const submitCode = async (e) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await verifyMfa(code); nav(after('supervisor'), { replace: true }); }
    catch (e2) { setErr(e2.message); setCode(''); } finally { setBusy(false); }
  };

  const loginAs = async (u) => {
    setBusy(true); setErr(null);
    try {
      await signInDemo(u.id);
      nav(after(u.role), { replace: true });
    } catch (e2) {
      setErr(e2.message || String(e2));
    } finally {
      setBusy(false);
    }
  };

  const sendOtp = (e) => {
    e.preventDefault();
    setErr(null);
    const clean = mobilePhone.replace(/\D/g, '').slice(-10);
    if (clean.length !== 10) {
      setErr('Enter a valid 10-digit mobile number');
      return;
    }
    const matched = staffList.find((u) => (u.phone || '').replace(/\D/g, '').endsWith(clean));
    if (!matched) {
      setErr(`No staff profile registered with mobile number +91 ${clean}. Contact your supervisor.`);
      return;
    }
    setOtpSent(true);
    setOtpSuccessNote(`OTP sent to +91 ${clean}. Test OTP: 123456`);
  };

  const verifyOtp = async (e) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const clean = mobilePhone.replace(/\D/g, '').slice(-10);
      const code = mobileOtp.trim();
      if (code !== '123456' && code !== '000000') {
        throw new Error('Invalid OTP. Use test OTP: 123456');
      }
      const matched = staffList.find((u) => (u.phone || '').replace(/\D/g, '').endsWith(clean));
      if (!matched) throw new Error('Staff profile not found');
      await signInDemo(matched.id);
      nav(after(matched.role), { replace: true });
    } catch (err2) {
      setErr(err2.message || String(err2));
    } finally {
      setBusy(false);
    }
  };

  // Staff filtering
  const needle = find.trim().toLowerCase();
  const filteredStaff = staffList.filter((x) => {
    if (needle) {
      return [x.full_name, x.email, x.phone, x.agent_code, x.provider, ...(x.skills || [])]
        .some((v) => String(v || '').toLowerCase().includes(needle));
    }
    return x.role === dept;
  });

  const countDept = (r) => staffList.filter((x) => x.role === r && x.active !== false).length;
  const currentDeptInfo = DEPARTMENTS.find(([k]) => k === dept) || [dept, ROLE_LABEL[dept] || dept, ''];

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
        <div className="login-card wide">
          {noProfile ? (
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
            <>
              {idleNote && <div className="badge info mb-12" style={{ height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }}>You were signed out after a period of inactivity.</div>}
              <div className="row between mb-8 wrap">
                <div>
                  <h1 style={{ fontSize: 22, margin: 0 }}>CareDesk Login</h1>
                  <p className="muted small mt-4">{isDemo || isLocal ? 'Select a test login.' : 'Sign in to your account. Supervisors can open staff workspaces from the first page.'}</p>
                </div>
                <div className="btn-group">
                  {(isDemo || isLocal) && <button type="button" className={`btn sm${authMode === 'dept' ? ' on' : ''}`} onClick={() => setAuthMode('dept')}>Department & Staff</button>}
                  <button type="button" className={`btn sm${authMode === 'otp' ? ' on' : ''}`} onClick={() => setAuthMode('otp')}>Mobile OTP (Field)</button>
                  <button type="button" className={`btn sm${authMode === 'password' ? ' on' : ''}`} onClick={() => setAuthMode('password')}>Email & Password</button>
                </div>
              </div>

              {authMode === 'otp' ? (
                <form onSubmit={otpSent ? verifyOtp : sendOtp} className="col gap-12 mt-12">
                  <p className="muted">Field staff sign in with registered mobile number and OTP.</p>
                  <Field label="Mobile number" hint="10-digit registered number">
                    <div className="row gap-4">
                      <span className="mono bold px-8 py-6 muted" style={{ border: '1px solid var(--line-2)', borderRadius: 3, background: 'var(--surface)', display: 'inline-flex', alignItems: 'center' }}>+91</span>
                      <Input
                        className="mono grow"
                        type="tel"
                        inputMode="numeric"
                        placeholder="98201 23456"
                        maxLength={10}
                        value={mobilePhone}
                        onChange={(e) => setMobilePhone(e.target.value.replace(/\D/g, ''))}
                        disabled={otpSent || busy}
                        required
                        autoFocus
                      />
                    </div>
                  </Field>
                  {otpSuccessNote && <div className="badge ok" style={{ height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }}>{otpSuccessNote}</div>}
                  {otpSent && (
                    <Field label="6-Digit OTP" hint="Test OTP: 123456">
                      <Input
                        className="mono"
                        inputMode="numeric"
                        maxLength={6}
                        placeholder="123456"
                        value={mobileOtp}
                        onChange={(e) => setMobileOtp(e.target.value.replace(/\D/g, ''))}
                        required
                        autoFocus
                      />
                    </Field>
                  )}
                  <ErrorNote error={err} />
                  <div className="row gap-8">
                    {otpSent ? (
                      <>
                        <Button kind="primary" size="lg" type="submit" disabled={busy || mobileOtp.length !== 6}>
                          {busy ? 'Verifying…' : 'Verify & Sign in'}
                        </Button>
                        <Button type="button" size="lg" onClick={() => { setOtpSent(false); setMobileOtp(''); setOtpSuccessNote(''); }}>
                          Change number
                        </Button>
                      </>
                    ) : (
                      <Button kind="primary" size="lg" type="submit" disabled={busy || mobilePhone.length !== 10}>
                        {busy ? 'Sending OTP…' : 'Send OTP'}
                      </Button>
                    )}
                  </div>
                  <p className="tiny faint">Field staff access is audited under DPDP Act 2023. Field technicians only see cases assigned to them.</p>
                </form>
              ) : authMode === 'password' ? (
                <form onSubmit={submit} className="col gap-12 mt-12">
                  <p className="muted">Use the work email and password issued by your administrator.</p>
                  <Field label="Work email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
                  <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
                  <ErrorNote error={err} />
                  <Button kind="primary" size="lg" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
                  <p className="tiny faint">Access is logged. Multi-factor authentication can be enabled under Settings → Security.</p>
                </form>
              ) : (
                <div className="col gap-12 mt-8">
                  <Input
                    placeholder="Search staff by name, email, code, skills (e.g. Rohit, A-08, xray, BMM)..."
                    value={find}
                    onChange={(e) => setFind(e.target.value)}
                    autoFocus
                  />

                  {!needle && (
                    <div className="login-dept-pills" role="tablist" aria-label="Departments">
                      {DEPARTMENTS.map(([k, label]) => {
                        const n = countDept(k);
                        return (
                          <button
                            key={k}
                            type="button"
                            role="tab"
                            aria-selected={k === dept}
                            className={`login-dept-pill${k === dept ? ' on' : ''}`}
                            onClick={() => setDept(k)}
                          >
                            <span>{label}</span>
                            <span className="badge">{n}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {!needle && currentDeptInfo && (
                    <div className="small muted mb-4" style={{ borderLeft: '2px solid var(--accent)', paddingLeft: 8 }}>
                      <strong>{currentDeptInfo[1]}</strong> · {currentDeptInfo[2]}
                    </div>
                  )}

                  <ErrorNote error={err} />

                  <div className="login-staff-list">
                    {filteredStaff.length === 0 ? (
                      <div className="panel-body center muted small py-16">
                        No staff found {needle ? `matching "${needle}"` : `in ${currentDeptInfo[1]}`}.
                      </div>
                    ) : (
                      filteredStaff.map((u) => {
                        const skills = u.skills?.length ? u.skills.join(', ') : null;
                        const partner = u.provider || (u.provider_id ? 'Partner' : null);
                        return (
                          <div key={u.id} className="login-staff-card">
                            <div className="grow">
                              <div className="row gap-6">
                                <strong style={{ fontSize: 13.5 }}>{u.full_name}</strong>
                                {u.agent_code && <Badge kind="outline" className="mono">{u.agent_code}</Badge>}
                                {needle && <Badge kind="solid">{ROLE_LABEL[u.role] || u.role}</Badge>}
                                {partner && <Badge kind="plum">{partner}</Badge>}
                              </div>
                              <div className="tiny muted mt-4 row wrap gap-6">
                                {u.email && <span>{u.email}</span>}
                                {u.phone && <span>· {u.phone}</span>}
                                {skills && <span>· Skills: <strong style={{ color: 'var(--ink)' }}>{skills}</strong></span>}
                                {u.myoperator_user_id && <span>· MyOperator: {u.myoperator_user_id}</span>}
                              </div>
                            </div>
                            <Button
                              kind="primary"
                              size="sm"
                              disabled={busy}
                              onClick={() => loginAs(u)}
                            >
                              Sign in
                            </Button>
                          </div>
                        );
                      })
                    )}
                  </div>

                  <p className="tiny faint mt-8">
                    {isDemo
                      ? 'Demo mode: In-browser database. Supervisors can select any department and sign in as any staff member.'
                      : isLocal
                      ? 'Local mode: Local Worker test database. Supervisors can select any department and sign in as any staff member.'
                      : 'Supervisors can select any department and sign in as specific staff, or use the Password tab to sign in with your work email.'}
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
