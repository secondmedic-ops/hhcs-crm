// Audit trail (slide 10): field-level record changes, access log and exports, filterable and downloadable as CSV.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { dateTime, istDateStr, ROLE_LABEL } from '../lib/fmt.js';
import { PageHead, Panel, Tabs, Badge, Button, Input, Select, TableSkeleton, Empty, ErrorNote, useAction } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';

const TABLES = ['cases', 'patients', 'payments', 'assignments', 'samples', 'approvals', 'escalations', 'complaints', 'services', 'templates', 'sla_policies', 'escalation_matrix', 'profiles', 'zones'];
const TABLE_LABEL = { cases: 'Cases', patients: 'Patients', payments: 'Payments', assignments: 'Field assignments', samples: 'Samples', approvals: 'Approvals', escalations: 'Escalations',
  complaints: 'Complaints', services: 'Rate card', templates: 'Templates', sla_policies: 'SLA policies', escalation_matrix: 'Escalation matrix', profiles: 'Users', zones: 'Zones' };
const ACCESS_ACTIONS = [['login', 'Login'], ['view_case', 'Viewed case'], ['view_patient', 'Viewed patient'], ['play_recording', 'Played recording'], ['export', 'Export']];
const ACCESS_LABEL = Object.fromEntries(ACCESS_ACTIONS);
const CHANGE_KIND = { insert: 'ok', update: 'info', delete: 'danger' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = 500;

const startIso = (d) => new Date(d + 'T00:00:00+05:30').toISOString();
const endIso = (d) => new Date(new Date(d + 'T00:00:00+05:30').getTime() + 86400e3).toISOString();

// readable cell for a jsonb value
function show(v) {
  if (v === null || v === undefined || v === '') return '–';
  if (typeof v === 'object') return JSON.stringify(v, null, 1).replace(/\n\s*/g, ' ');
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return dateTime(v);
  return String(v);
}

export default function Audit() {
  const nav = useNavigate();
  const [tab, setTab] = useState('changes');
  const [from, setFrom] = useState(istDateStr(-6));
  const [to, setTo] = useState(istDateStr(0));
  const [table, setTable] = useState('');
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [text, setText] = useState('');
  const term = useDebounced(text.trim(), 300);
  const [run, busy] = useAction();
  const switchTab = (t) => { setTab(t); setAction(''); };

  const people = useLoad(() => q(db.from('profiles').select('id,full_name,role').order('full_name')), []);
  const lo = from <= to ? from : to, hi = from <= to ? to : from;

  const data = useLoad(async () => {
    if (tab === 'changes') {
      let x = db.from('v_audit').select('id,at,actor_id,actor_name,actor_role,table_name,record_id,action,changes').gte('at', startIso(lo)).lt('at', endIso(hi));
      if (table) x = x.eq('table_name', table);
      if (actor === 'system') x = x.is('actor_id', null); else if (actor) x = x.eq('actor_id', actor);
      if (action) x = x.eq('action', action);
      if (UUID.test(term)) x = x.eq('record_id', term);
      return q(x.order('at', { ascending: false }).limit(LIMIT));
    }
    let x = db.from('v_access').select('id,at,user_id,user_name,user_role,action,entity,entity_id,meta').gte('at', startIso(lo)).lt('at', endIso(hi));
    if (tab === 'exports') x = x.eq('action', 'export'); else if (action) x = x.eq('action', action);
    if (actor) x = x.eq('user_id', actor);
    if (term) x = x.ilike('entity_id', `%${term.replace(/[%_]/g, '')}%`);
    return q(x.order('at', { ascending: false }).limit(LIMIT));
  }, [tab, lo, hi, table, actor, action, term], tab === 'changes' ? ['audit_log'] : ['access_log']);

  // partial record-id search on the changes tab is done client side (uuid columns cannot be pattern-matched over the API)
  const rows = useMemo(() => {
    const d = data.data || [];
    if (tab !== 'changes' || !term || UUID.test(term)) return d;
    const t = term.toLowerCase();
    return d.filter((r) => String(r.record_id || '').toLowerCase().includes(t));
  }, [data.data, tab, term]);

  const download = () => run(async () => {
    const head = tab === 'changes' ? ['at_ist', 'actor', 'role', 'table', 'record_id', 'action', 'field', 'old', 'new']
      : ['at_ist', 'user', 'role', 'action', 'entity', 'entity_id', 'meta'];
    const lines = [];
    rows.forEach((r) => {
      if (tab === 'changes') {
        const base = [dateTime(r.at), r.actor_name || 'System', ROLE_LABEL[r.actor_role] || '', r.table_name, r.record_id, r.action];
        const diffs = r.action === 'update' && r.changes ? Object.entries(r.changes) : [];
        if (diffs.length) diffs.forEach(([k, v]) => lines.push([...base, k, show(v?.old), show(v?.new)]));
        else lines.push([...base, '', '', r.action === 'delete' ? JSON.stringify(r.changes) : '']);
      } else lines.push([dateTime(r.at), r.user_name || '', ROLE_LABEL[r.user_role] || '', r.action, r.entity || '', r.entity_id || '', JSON.stringify(r.meta || {})]);
    });
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = '﻿' + [head, ...lines].map((l) => l.map(esc).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `HHCS-audit-${tab}-${lo}_${hi}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    await rpc('log_access', { p_action: 'export', p_entity: 'audit', p_entity_id: tab, p_meta: { from: lo, to: hi, format: 'csv', rows: rows.length, table: table || null, actor: actor || null, action: action || null } });
  }, 'CSV downloaded · export logged');

  const clear = () => { setTable(''); setActor(''); setAction(''); setText(''); };
  const filtered = table || actor || action || text;

  return (
    <>
      <PageHead title="Audit trail" sub="Who changed what, who opened which record, and every export · read-only, kept for the contract term">
        <Button icon="download" onClick={download} disabled={busy || data.loading || !rows.length}>Download CSV</Button>
      </PageHead>

      <div className="grid g-main-side">
        <div className="col gap-12" style={{ minWidth: 0 }}>
          <Tabs value={tab} onChange={switchTab} tabs={[['changes', 'Record changes'], ['access', 'Access log'], ['exports', 'Exports only']]} />

          <div className="row wrap au-filters">
            <Field2 label="From"><Input type="date" value={from} max={istDateStr(0)} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field2>
            <Field2 label="To"><Input type="date" value={to} max={istDateStr(0)} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field2>
            {tab === 'changes' && <Field2 label="Table"><Select value={table} onChange={(e) => setTable(e.target.value)} placeholder="All tables" options={TABLES.map((t) => [t, TABLE_LABEL[t]])} /></Field2>}
            <Field2 label={tab === 'changes' ? 'Changed by' : 'User'}>
              <Select value={actor} onChange={(e) => setActor(e.target.value)} placeholder="Anyone"
                options={[...(tab === 'changes' ? [['system', 'System / automation']] : []), ...(people.data || []).map((p) => [p.id, `${p.full_name} · ${ROLE_LABEL[p.role]}`])]} />
            </Field2>
            {tab !== 'exports' && <Field2 label="Action"><Select value={action} onChange={(e) => setAction(e.target.value)} placeholder="Any"
              options={tab === 'changes' ? [['insert', 'Created'], ['update', 'Updated'], ['delete', 'Deleted']] : ACCESS_ACTIONS} /></Field2>}
            <Field2 label={tab === 'changes' ? 'Record id' : 'Entity id'} grow><Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste or type part of an id" className="mono" /></Field2>
            {filtered && <Button size="sm" kind="ghost" icon="x" onClick={clear}>Clear</Button>}
          </div>

          <ErrorNote error={data.error} />
          <Panel tight title={<span className="small muted">{data.loading ? 'Loading' : `${rows.length}${(data.data || []).length >= LIMIT ? '+' : ''} entries · ${lo === hi ? lo : `${lo} to ${hi}`} · IST`}</span>}>
            {data.loading ? <TableSkeleton rows={10} cols={6} /> : !rows.length ? <Empty title="Nothing logged for these filters">Widen the date range or clear a filter.</Empty>
              : tab === 'changes' ? <Changes rows={rows} nav={nav} /> : <Access rows={rows} nav={nav} />}
            {(data.data || []).length >= LIMIT && <div className="small muted" style={{ padding: '8px 12px' }}>Showing the latest {LIMIT}. Narrow the date range to see older entries.</div>}
          </Panel>
        </div>

        <div className="col gap-12">
          <Panel title="What is logged">
            <ul className="au-list small">
              <li><strong>Calls:</strong> 100% of calls are recorded by MyOperator; every playback is logged with the user and time.</li>
              <li><strong>Transcripts:</strong> AI transcripts and summaries sit on the case and patient timeline next to the recording.</li>
              <li><strong>Field-level edits:</strong> every change to cases, patients, payments, samples, the rate card, templates, SLAs, users and zones, with old and new values.</li>
              <li><strong>Logins and views:</strong> each sign-in and each time a case or patient record is opened.</li>
              <li><strong>Every export:</strong> MIS packs, audit CSVs and full data exports, with period and format.</li>
            </ul>
            <div className="tiny faint mt-8">Entries are written by the database itself, so they cannot be skipped by the app. No user, including the platform admin, can edit or delete them.</div>
          </Panel>
          <Panel title="Who can see this">
            <div className="small">The SecondMedic supervisor and Hinduja management. Downloads from this page are themselves logged as exports.</div>
          </Panel>
        </div>
      </div>
    </>
  );
}

const Field2 = ({ label, children, grow }) => <label className={`f au-f ${grow ? 'grow' : ''}`}><span>{label}</span>{children}</label>;

function recordLink(r, nav) {
  if (!r.record_id) return <span className="muted">–</span>;
  const path = r.table_name === 'cases' ? `/cases/${r.record_id}` : r.table_name === 'patients' ? `/patients/${r.record_id}` : null;
  const shortId = r.record_id.slice(0, 8);
  if (!path || r.action === 'delete') return <span className="mono small" title={r.record_id}>{shortId}</span>;
  return <a href={path} className="mono small" title={r.record_id} onClick={(e) => { e.preventDefault(); nav(path); }}>{shortId}</a>;
}

function Value({ v }) {
  const s = show(v);
  if (s.length <= 90) return <span className="mono">{s}</span>;
  return <details className="au-long"><summary className="mono">{s.slice(0, 80)}…</summary><pre>{typeof v === 'object' ? JSON.stringify(v, null, 2) : s}</pre></details>;
}

function Changes({ rows, nav }) {
  return (
    <div className="table-wrap"><table className="t au-table">
      <thead><tr><th>When</th><th>Changed by</th><th>Record</th><th>Action</th><th>Changes</th></tr></thead>
      <tbody>{rows.map((r) => {
        const diffs = r.action === 'update' && r.changes ? Object.entries(r.changes) : [];
        return (
          <tr key={r.id} style={{ verticalAlign: 'top' }}>
            <td className="nowrap small mono">{dateTime(r.at)}</td>
            <td className="nowrap"><div className="small">{r.actor_name || 'System'}</div><div className="tiny muted">{r.actor_role ? ROLE_LABEL[r.actor_role] : 'trigger / job'}</div></td>
            <td className="nowrap"><div className="small">{TABLE_LABEL[r.table_name] || r.table_name}</div>{recordLink(r, nav)}</td>
            <td><Badge kind={CHANGE_KIND[r.action]}>{r.action === 'insert' ? 'Created' : r.action === 'update' ? 'Updated' : r.action === 'delete' ? 'Deleted' : r.action}</Badge></td>
            <td className="au-changes">
              {diffs.length ? diffs.map(([k, v]) => (
                <div key={k} className="au-diff"><span className="au-field">{k}</span><Value v={v?.old} /><Icon name="chevron" size={11} className="faint" /><Value v={v?.new} /></div>
              )) : r.action === 'delete' && r.changes ? <Value v={r.changes} /> : <span className="small muted">{r.action === 'insert' ? 'Record created' : '–'}</span>}
            </td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}

function Access({ rows, nav }) {
  const link = (r) => {
    if (r.entity === 'case' && r.entity_id) return <a href={`/cases/${r.entity_id}`} className="mono small" onClick={(e) => { e.preventDefault(); nav(`/cases/${r.entity_id}`); }}>{r.entity_id.slice(0, 8)}</a>;
    if (r.entity === 'patient' && r.entity_id) return <a href={`/patients/${r.entity_id}`} className="mono small" onClick={(e) => { e.preventDefault(); nav(`/patients/${r.entity_id}`); }}>{r.entity_id.slice(0, 8)}</a>;
    return <span className="mono small" title={r.entity_id || ''}>{r.entity_id ? (r.entity_id.length > 24 ? r.entity_id.slice(0, 24) + '…' : r.entity_id) : '–'}</span>;
  };
  return (
    <div className="table-wrap"><table className="t">
      <thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th><th>Id</th><th>Details</th></tr></thead>
      <tbody>{rows.map((r) => {
        const meta = Object.entries(r.meta || {}).filter(([, v]) => v !== null && v !== '');
        return (
          <tr key={r.id}>
            <td className="nowrap small mono">{dateTime(r.at)}</td>
            <td className="nowrap"><div className="small">{r.user_name || '–'}</div><div className="tiny muted">{ROLE_LABEL[r.user_role] || ''}</div></td>
            <td><Badge kind={r.action === 'export' ? 'warn' : r.action === 'play_recording' ? 'plum' : r.action === 'login' ? '' : 'info'}>{ACCESS_LABEL[r.action] || r.action}</Badge></td>
            <td className="small">{r.entity || '–'}</td>
            <td>{link(r)}</td>
            <td className="small mono muted">{meta.length ? meta.map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '–'}</td>
          </tr>
        );
      })}</tbody>
    </table></div>
  );
}
