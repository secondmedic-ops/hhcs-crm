import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { db, q, rpc, isDemo, isLocal, resetDemo, subscribe } from '../lib/db.js';
import { NAV, homeFor, roleAllows, useAuth } from '../lib/auth.jsx';
import { useKey, useLoad } from '../lib/hooks.js';
import { ago, ROLE_LABEL } from '../lib/fmt.js';
import Icon from './icons.jsx';
import CommandBar from './CommandBar.jsx';
import { Avatar, Button, Badge, useToast } from './ui.jsx';
import { DEMO_USERS } from '../demo/seed.js';

const GROUPS = [
  ['Operate', ['/', '/leads', '/console', '/cases', '/callbacks', '/calls', '/whatsapp', '/patients', '/field', '/my-visits', '/checklist']],
  ['Govern', ['/approvals', '/escalations', '/complaints', '/mis', '/audit']],
  ['Configure', ['/settings']],
];

export default function Shell() {
  const { profile, workspace, signOut, staffSession } = useAuth();
  const [cmd, setCmd] = useState(false);
  const [menu, setMenu] = useState(false);
  const loc = useLocation();
  useKey('mod+k', useCallback(() => setCmd(true), []));
  useEffect(() => setMenu(false), [loc.pathname]);

  const counts = useLoad(async () => {
    const sees = (to) => NAV.some((n) => n.to === to && roleAllows(n.roles, profile?.role));   // only badges this role has menu items for
    const [a, e, w] = await Promise.all([
      sees('/approvals') ? q(db.from('approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending')).catch(() => 0) : 0,
      sees('/escalations') ? q(db.from('escalations').select('id', { count: 'exact', head: true }).neq('status', 'resolved')).catch(() => 0) : 0,
      sees('/whatsapp') ? q(db.from('v_whatsapp_chats').select('id', { count: 'exact', head: true }).eq('needs_reply', true)).catch(() => 0) : 0,
    ]);
    return { approvals: a, escalations: e, whatsapp: w };
  }, [profile?.id], ['approvals', 'escalations', 'interactions', 'cases']);

  const items = NAV.filter((n) => roleAllows(n.roles, profile.role));
  return (
    <div className="shell">
      <aside className={`side ${menu ? 'open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">HC</div>
          <div className="col" style={{ gap: 0 }}>
            <span className="brand-name">{workspace?.brand_name || 'CareDesk'}</span>
            <span className="brand-sub">CareDesk · operated by SecondMedic</span>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          {GROUPS.map(([g, paths]) => {
            const list = items.filter((i) => paths.includes(i.to));
            if (!list.length) return null;
            return (
              <div key={g}>
                <div className="nav-group">{g}</div>
                {list.map((n) => (
                  <NavLink key={n.to} to={n.to} end={n.to === '/'}>
                    <Icon name={n.icon} />{n.label}
                    {n.badge && counts.data?.[n.badge] > 0 && <span className="count">{counts.data[n.badge]}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="side-foot">
          <div className="who">
            <Avatar name={profile.full_name} dark />
            <div className="grow col" style={{ gap: 0 }}>
              <span className="truncate" style={{ color: '#fff' }}>{profile.full_name}</span>
              <span className="tiny" style={{ color: 'var(--side-muted)' }}>{ROLE_LABEL[profile.role]}{profile.agent_code ? ` · ${profile.agent_code}` : ''}</span>
            </div>
            <button className="btn ghost sm" style={{ color: 'var(--side-ink)' }} onClick={() => signOut()} title="Sign out" aria-label="Sign out"><Icon name="out" /></button>
          </div>
          <div className="tiny mt-8" style={{ color: 'var(--side-muted)' }}>
            <a href="/terms" style={{ color: 'inherit' }}>Terms</a> · <a href="/privacy" style={{ color: 'inherit' }}>Privacy</a> · DPDP Act 2023
          </div>
        </div>
      </aside>
      <div className="main">
        {staffSession && <StaffSessionBanner />}
        {(isDemo || isLocal) && <DemoBar />}
        <header className="topbar">
          <button className="btn ghost sm menu-btn" onClick={() => setMenu((m) => !m)} aria-label="Menu"><Icon name="menu" /></button>
          <button className="cmd-trigger" onClick={() => setCmd(true)}>
            <Icon name="search" /> <span>Search or ask anything…</span>
            <span className="kbd" style={{ marginLeft: 'auto' }}>Ctrl K</span>
          </button>
          <div className="grow" />
          <Availability />
          <Notifications />
        </header>
        <main className="page"><Outlet /></main>
      </div>
      {cmd && <CommandBar onClose={() => setCmd(false)} />}
    </div>
  );
}

function StaffSessionBanner() {
  const { staffSession, returnToSupervisor } = useAuth();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => { returnToSupervisor(); }, Math.max(0, new Date(staffSession.expiresAt).getTime() - Date.now()));
    return () => clearTimeout(t);
  }, [staffSession.id]);
  return <div className="panel-body row wrap gap-12" role="status" style={{ borderBottom: '1px solid var(--line)' }}>
    <div className="grow"><strong>{staffSession.staffName} - Supervisor ({staffSession.supervisorName})</strong><div className="tiny muted">Working with this staff member's permissions. Every action keeps your supervisor identity in the audit trail.</div></div>
    <Button disabled={busy} onClick={() => { setBusy(true); returnToSupervisor(); }}>Return to supervisor</Button>
  </div>;
}

// Available / Away for auto-dialled callbacks: the dialer rings only agents who are Available, linked to MyOperator
// and not on a call. Shown to the roles that take callbacks.
function Availability() {
  const { profile, can, reload } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!can('agent', 'coordinator', 'supervisor')) return null;
  const on = !!profile.available;
  const toggle = async () => {
    setBusy(true);
    try {
      const r = await rpc('set_my_availability', { p_available: !on });
      await reload();
      if (r?.available && !r.linked) toast.error('You are Available, but your login is not linked to MyOperator yet, so no calls can be routed to you.');
      else toast(r?.available ? 'Available: auto-dialled callbacks will ring your phone' : 'Away: no auto-dialled callbacks');
    } catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  return (
    <Button size="sm" kind={on ? 'primary' : undefined} disabled={busy} onClick={toggle} aria-pressed={on}
      title={on ? 'You receive auto-dialled callbacks. Click to go Away.' : 'Click to receive auto-dialled callbacks'}>
      <span className="dot" style={{ color: on ? 'var(--ok)' : 'var(--faint)' }} />{on ? 'Available' : 'Away'}
    </Button>
  );
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const toast = useToast();
  const { data, reload } = useLoad(() => q(db.from('notifications').select('*').order('created_at', { ascending: false }).limit(20)), [], ['notifications']);
  const unread = (data || []).filter((n) => !n.read_at).length;
  useEffect(() => subscribe(['notifications'], () => {}), []);
  useEffect(() => {
    if (!data?.length) return;
    const newest = data[0];
    if (!newest.read_at && Date.now() - new Date(newest.created_at) < 8000) toast(newest.title, newest.kind === 'danger' ? 'error' : 'info');
  }, [data?.[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const markAll = async () => { await db.from('notifications').update({ read_at: new Date().toISOString() }).is('read_at', null); reload(); };
  return (
    <div style={{ position: 'relative' }}>
      <Button kind="ghost" onClick={() => setOpen((o) => !o)} aria-label="Notifications">
        <Icon name="bell" />{unread > 0 && <Badge kind="danger">{unread}</Badge>}
      </Button>
      {open && (
        <div className="panel" style={{ position: 'absolute', right: 0, top: 38, width: 360, zIndex: 50 }}>
          <div className="panel-head"><h3>Notifications</h3><Button size="xs" kind="ghost" onClick={markAll}>Mark all read</Button></div>
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {(data || []).length === 0 && <div className="empty small">You're all caught up</div>}
            {(data || []).map((n) => (
              <div key={n.id} className="list-row click" onClick={() => { setOpen(false); if (n.link) nav(n.link); }}>
                <span className="dot" style={{ color: n.read_at ? 'transparent' : n.kind === 'danger' ? 'var(--danger)' : n.kind === 'warn' ? 'var(--warn)' : 'var(--accent)' }} />
                <div className="grow">
                  <div className="strong small">{n.title}</div>
                  {n.body && <div className="small muted truncate">{n.body}</div>}
                </div>
                <span className="tiny faint nowrap">{ago(n.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DemoBar() {
  const { profile, signInDemo } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const switchTo = async (id) => {
    await signInDemo(id);
    const u = DEMO_USERS.find((x) => x.id === id);
    nav(homeFor(u.role));
  };
  const inbound = async (scripted) => {
    if (!roleAllows(['agent', 'coordinator', 'supervisor'], profile.role)) { toast('Switch to an agent to receive calls'); return; }
    if (isLocal) {
      const { localInboundCall } = await import('../lib/localsim.js');
      try { await localInboundCall(); toast('Test call sent to the local Worker as a MyOperator webhook'); } catch (e) { toast.error(e.message); }
      return;
    }
    const { simulateInboundCall } = await import('../demo/sim.js');
    await simulateInboundCall(scripted ? 'demo' : null);
  };
  const inboundWhatsApp = async () => {
    if (!roleAllows(['agent', 'coordinator', 'supervisor', 'medical_desk'], profile.role)) { toast('Switch to an operations login to receive WhatsApp chats'); return; }
    if (isLocal) {
      const { localInboundWhatsApp } = await import('../lib/localsim.js');
      try { await localInboundWhatsApp(); toast('Inbound WhatsApp sent to local Worker'); nav('/whatsapp'); } catch (e) { toast.error(e.message); }
      return;
    }
    const { simulateInboundWhatsApp } = await import('../demo/sim.js');
    const r = await simulateInboundWhatsApp();
    toast(`WhatsApp message received from ${r.patient_name || 'Patient'}`);
    nav(`/whatsapp?patient=${r.patient_id}`);
  };
  return (
    <div className="demo-bar no-print">
      <strong>{isLocal ? 'LOCAL TEST' : 'DEMO'}</strong>
      <span>{isLocal ? 'Real API on this computer, throw-away test database. Live data is never touched.' : 'In-browser database with sample data. Nothing leaves this browser.'}</span>
      <span className="grow" />
      <label className="row gap-4">View as
        <select value={profile.id} onChange={(e) => switchTo(e.target.value)}>
          {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.full_name} · {ROLE_LABEL[u.role]}</option>)}
        </select>
      </label>
      <button onClick={() => inbound(true)}>Simulate test call</button>
      <button onClick={inboundWhatsApp}>Simulate WhatsApp</button>
      {isDemo && <button onClick={() => inbound(false)}>Random inbound call</button>}
      {isDemo && <button onClick={() => { if (confirm('Reset the demo data?')) resetDemo(); }}>Reset</button>}
    </div>
  );
}
