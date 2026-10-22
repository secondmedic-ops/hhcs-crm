import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { db, isDemo, isLocal, supabase, demoSession, q, rpc } from './db.js';
import { DEMO_USERS } from '../demo/seed.js';
import { api, setStaffSession as saveStaffSession } from '../api.ts';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

// What each role can open. Mirrors the RLS role matrix (slide 20).
export const NAV = [
  { to: '/feedback-list', label: 'Customer feedback', icon: 'chat', roles: ['agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'] },
  // Book My Medicare's own workspace (leads, jobs, products, team). `when` hides it from field staff with no provider.
  { to: '/bmm', label: 'BMM workspace', icon: 'board', roles: ['provider', 'field_staff', 'supervisor', 'coordinator', 'client_manager'], when: (p) => p.role !== 'field_staff' || !!p.provider_id },
  { to: '/fulfilment', label: 'Provider fulfilment', icon: 'swap', roles: ['provider','field_staff','supervisor','coordinator','agent','client_manager','client_clinical','medical_desk'] },
  { to: '/', label: 'Live dashboard', icon: 'pulse', roles: ['supervisor', 'coordinator', 'client_manager', 'client_clinical', 'medical_desk'] },
  { to: '/console', label: 'Agent console', icon: 'headset', roles: ['agent', 'supervisor', 'coordinator'] },
  { to: '/leads', label: 'Provider leads', icon: 'swap', roles: ['provider', 'supervisor', 'coordinator', 'client_manager', 'agent'] },
  { to: '/cases', label: 'Cases', icon: 'folder', roles: ['agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical', 'provider'] },
  { to: '/callbacks', label: 'Callback queue', icon: 'return', roles: ['agent', 'coordinator', 'supervisor', 'client_manager'] },
  { to: '/calls', label: 'Calls & recordings', icon: 'phone', roles: ['agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'] },
  { to: '/whatsapp', label: 'WhatsApp chats', icon: 'chat', roles: ['agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'], badge: 'whatsapp' },
  { to: '/email', label: 'Email', icon: 'mail', roles: ['agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'], badge: 'email' },
  { to: '/patients', label: 'Patients', icon: 'person', roles: ['agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'] },
  { to: '/field', label: 'Dispatch board', icon: 'pin', roles: ['coordinator', 'supervisor', 'client_manager'] },
  { to: '/my-visits', label: 'My visits', icon: 'pin', roles: ['field_staff'] },
  { to: '/checklist', label: 'Assessment checklist', icon: 'list', roles: ['coordinator', 'field_staff', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'] },
  { to: '/knowledge', label: 'Product knowledge', icon: 'note', roles: ['agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical', 'admin', 'provider', 'field_staff'] },
  { to: '/approvals', label: 'Approvals', icon: 'stamp', roles: ['client_manager', 'supervisor', 'coordinator', 'admin'], badge: 'approvals' },
  { to: '/escalations', label: 'Escalations', icon: 'flag', roles: ['coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'], badge: 'escalations' },
  { to: '/complaints', label: 'Complaints', icon: 'alert', roles: ['agent', 'coordinator', 'supervisor', 'client_manager', 'client_clinical', 'medical_desk'] },
  { to: '/mis', label: 'MIS reports', icon: 'report', roles: ['supervisor', 'coordinator', 'client_manager', 'client_clinical'] },
  { to: '/audit', label: 'Audit trail', icon: 'shield', roles: ['supervisor', 'client_manager'] },
  { to: '/settings', label: 'Settings', icon: 'gear', roles: ['admin', 'supervisor', 'client_manager', 'coordinator', 'agent', 'medical_desk', 'client_clinical', 'field_staff', 'provider'] },
];

/** Same rule as the server and has_role() in the database: an administrator passes any list that names a senior role
 *  (supervisor, Hinduja management or clinical, coordinator, medical desk) or the platform admin. Lists of only agent /
 *  field staff / partner roles stay closed to it. */
const SENIOR = ['supervisor', 'client_manager', 'client_clinical', 'coordinator', 'medical_desk', 'admin'];
export const roleAllows = (roles, role) => !!role && (roles.includes(role) || (role === 'administrator' && roles.some((r) => SENIOR.includes(r))));

export const homeFor = (role, providerId) => role === 'field_staff' && providerId ? '/bmm' : ({ agent: '/console', field_staff: '/my-visits', admin: '/settings', provider: '/bmm' }[role] || '/');

export function AuthProvider({ children }) {
  const [profile, setProfile] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mfa, setMfa] = useState(null); // { factorId, userId } while a second factor is owed
  const [noProfile, setNoProfile] = useState(false); // signed in to Supabase, but no CareDesk profile yet
  const [staffSession, setStaffSession] = useState(null);

  const load = useCallback(async (userId) => {
    if (!userId) { saveStaffSession(null); setStaffSession(null); setProfile(null); setWorkspace(null); return; }
    let p = null, why = null;
    try {
      if (!isDemo) {
        const me = await api.me();
        userId = me.userId;
        setStaffSession(me.staffSession || null);
      }
      p = await q(db.from('profiles').select('*').eq('id', userId).maybeSingle());
    }
    catch (e) { why = e.message || String(e); }
    if (!p && isDemo) {
      const demoU = DEMO_USERS.find((x) => x.id === userId);
      if (demoU) {
        p = {
          ...demoU,
          active: true,
          workspace_id: 'w0000000-0000-4000-8000-000000000001',
          created_at: new Date().toISOString(),
        };
        why = null;
      }
    }
    setProfile(p);
    // false = no problem; true = no profile row; text = the server's error (shown on the start screen)
    setNoProfile(!p && !isDemo && !isLocal ? (why || true) : false);
    if (p) {
      let ws = null;
      try { ws = await q(db.from('workspaces').select('*').eq('id', p.workspace_id).maybeSingle()); } catch {}
      setWorkspace(ws || { id: p.workspace_id, name: 'Hinduja Hospital', settings: {} });
      rpc('log_access', { p_action: 'login', p_entity: null, p_entity_id: null, p_meta: {} }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const picked = demoSession.restore();
        if (picked) {
          await load(picked);
        } else if (isDemo || isLocal) {
          await load(null);
        } else {
          const { data } = await supabase.auth.getSession();
          await gate(data.session?.user?.id);
          supabase.auth.onAuthStateChange((e, s) => { if (e !== 'MFA_CHALLENGE_VERIFIED') gate(s?.user?.id); });
        }
      } finally { setLoading(false); }
    })();
  }, [load]);

  // Slide 20: multi-factor login. A user with a verified authenticator must pass it before any data loads.
  async function gate(userId) {
    if (!userId) { setMfa(null); return load(null); }
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data?.nextLevel === 'aal2' && data?.currentLevel !== 'aal2') {
      const f = await supabase.auth.mfa.listFactors();
      const factor = (f.data?.totp || []).find((x) => x.status === 'verified');
      if (factor) { setProfile(null); setMfa({ factorId: factor.id, userId }); return undefined; }
    }
    setMfa(null);
    return load(userId);
  }
  const verifyMfa = async (code) => {
    const ch = await supabase.auth.mfa.challenge({ factorId: mfa.factorId });
    if (ch.error) throw ch.error;
    const v = await supabase.auth.mfa.verify({ factorId: mfa.factorId, challengeId: ch.data.id, code: code.trim() });
    if (v.error) throw v.error;
    const userId = mfa.userId;
    setMfa(null);
    await load(userId);
  };

  // Slide 20: auto-logout after inactivity (workspace setting, default 30 min; off in demo)
  useEffect(() => {
    if (isDemo || isLocal || !profile) return undefined;
    const mins = Number(workspace?.settings?.idle_logout_minutes ?? 30);
    if (!mins) return undefined;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const evs = ['pointerdown', 'keydown', 'scroll', 'touchstart'];
    evs.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last > mins * 60000) {
        sessionStorage.setItem('caredesk.idle', '1');
        signOut();
      }
    }, 20000);
    return () => { clearInterval(t); evs.forEach((e) => window.removeEventListener(e, bump)); };
  }, [profile?.id, workspace?.settings?.idle_logout_minutes]);

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };
  const signInDemo = async (userId) => {
    if (!isDemo && !isLocal) throw new Error('Sign in with your supervisor email and password first.');
    saveStaffSession(null);
    demoSession.set(userId); await load(userId);
  };
  const switchUser = async (staffId) => {
    if (isDemo) throw new Error('Audited staff access is available on the live site and in the local Worker test.');
    const s = await api.startStaffSession(staffId);
    saveStaffSession(s.id);
    // Reload clears all prior-role data, call panels and in-flight loaders.
    window.location.assign('/');
  };
  const returnToSupervisor = async () => {
    try { await api.endStaffSession(); }
    finally { saveStaffSession(null); window.location.assign('/'); }
  };
  // after sign-out the address goes back to "/", so the next person who logs in lands on their own role's home page,
  // not on the page the previous user was on (e.g. Settings)
  const resetAddress = () => { try { window.history.replaceState(null, '', '/'); } catch { /* not a browser */ } };
  const signOut = async () => {
    try {
      if (staffSession && !isDemo) await api.endStaffSession().catch(() => {});
      if (isDemo || isLocal) {
        demoSession.set(null);
      } else if (supabase) {
        await supabase.auth.signOut().catch(() => {});
      }
    } catch {
      /* ignore sign out errors */
    } finally {
      try {
        demoSession.set(null);
        sessionStorage.clear();
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && (k.startsWith('sb-') || k.includes('auth') || k.includes('token') || k.includes('caredesk'))) {
            localStorage.removeItem(k);
          }
        }
      } catch { /* storage blocked */ }
      setProfile(null);
      setMfa(null);
      setNoProfile(false);
      resetAddress();
      window.location.href = '/';
    }
  };
  const can = (...roles) => !!profile && roleAllows(roles, profile.role);
  const isClient = profile && ['client_manager', 'client_clinical'].includes(profile.role);
  const isOps = profile && roleAllows(['agent', 'coordinator', 'supervisor', 'medical_desk'], profile.role);

  return (
    <AuthCtx.Provider value={{ profile, workspace, loading, mfa, noProfile, verifyMfa, signIn, signInDemo, switchUser, staffSession, returnToSupervisor, signOut, can, isClient, isOps, reload: () => load(profile?.id), retry: async () => { const { data } = await supabase.auth.getSession(); await load(data.session?.user?.id); } }}>
      {children}
    </AuthCtx.Provider>
  );
}
