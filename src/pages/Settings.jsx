// Settings: profile & MFA, workspace policy, rate card (selling, buying, import: RateCard.jsx), templates, SLAs, escalation matrix, zones, users,
// telephony & integrations, and the data-exit export. Each tab is shown only to the roles that can use it.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { db, q, rpc, isDemo, supabase } from '../lib/db.js';
import { createUser, webhookEvents, integrations, moSettings, saveMoSettings, testMo, moUsers, linkMoUsers, setTelephony, syncMo, aiSettings, saveAiSettings, testAi } from '../lib/api.js';
import { useLoad } from '../lib/hooks.js';
import { homeFor, roleAllows, useAuth } from '../lib/auth.jsx';
import { dateTime, ago, ROLE_LABEL, DEPARTMENTS } from '../lib/fmt.js';
import {
  PageHead, Panel, Tabs, Badge, Button, Modal, Drawer, Field, Input, Select, Textarea, Check, Segmented, Kpi,
  TableSkeleton, Skeleton, Empty, ErrorNote, useAction, useToast,
} from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { STAFF_ROLES } from '../components/StaffWorkspace.jsx';
import { RatesTab } from './RateCard.jsx';

const ALL = ['agent', 'coordinator', 'supervisor', 'field_staff', 'medical_desk', 'client_manager', 'client_clinical', 'admin', 'provider', 'administrator'];
const TABS = [
  ['profile', 'Profile & security', ALL],
  ['workspace', 'Workspace', ['client_manager', 'admin']],
  ['rates', 'Rate card', ALL],
  ['templates', 'Templates & scripts', ALL],
  ['sla', 'SLA policies', ALL],
  ['escalation', 'Escalation matrix', ALL],
  ['zones', 'Zones', ['supervisor', 'admin']],
  ['users', 'Users', ['admin', 'supervisor']],
  ['departments', 'Departments & staff', ['admin', 'supervisor']],
  ['telephony', 'Telephony & integrations', ['admin', 'supervisor']],
  ['import', 'Import from old CRM', ['supervisor', 'client_manager']],
  ['data', 'Data & exit', ['client_manager']],
];
const KIND = { script: 'Call script', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email' };
const T_STATUS = { approved: 'ok', pending: 'warn', draft: 'info', retired: '' };
const ESC_TYPE = { clinical: 'Clinical', emergency: 'Emergency', delay: 'Field delay', complaint: 'Complaint', privacy: 'Privacy / data' };
const dash = (v) => (v == null || v === '' ? '–' : v);
const mins = (m) => (m == null ? '–' : m === 0 ? 'immediate' : m >= 1440 ? `${+(m / 1440).toFixed(1)} d` : m >= 120 ? `${+(m / 60).toFixed(1)} h` : `${m} min`);
const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export default function Settings() {
  const { profile } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tabs = TABS.filter(([, , roles]) => roleAllows(roles, profile.role));
  const tab = tabs.some(([k]) => k === sp.get('tab')) ? sp.get('tab') : tabs[0][0];
  return (
    <>
      <PageHead title="Settings" sub="Configuration is versioned and every change is written to the audit trail" />
      <Tabs value={tab} onChange={(t) => setSp({ tab: t }, { replace: true })} tabs={tabs.map(([k, l]) => [k, l])} />
      {tab === 'profile' && <ProfileTab />}
      {tab === 'workspace' && <WorkspaceTab />}
      {tab === 'rates' && <RatesTab />}
      {tab === 'templates' && <TemplatesTab />}
      {tab === 'sla' && <SlaTab />}
      {tab === 'escalation' && <EscalationTab />}
      {tab === 'zones' && <ZonesTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'departments' && <DepartmentsTab />}
      {tab === 'telephony' && <TelephonyTab />}
      {tab === 'import' && <ImportTab />}
      {tab === 'data' && <DataTab />}
    </>
  );
}

// ------------------------------------------------------------------ profile & MFA
function ProfileTab() {
  const { profile, workspace, can, reload } = useAuth();
  const admin = can('admin');
  const [f, setF] = useState({ myoperator_user_id: profile.myoperator_user_id || '', myoperator_extension: profile.myoperator_extension || '' });
  const [run, busy] = useAction();
  const save = () => run(async () => {
    await q(db.from('profiles').update({ myoperator_user_id: f.myoperator_user_id.trim() || null, myoperator_extension: f.myoperator_extension.trim() || null }).eq('id', profile.id));
    reload();
  }, 'Telephony ids saved');
  return (
    <div className="grid g2">
      <Panel title="Your profile" sub={workspace?.name}>
        <dl className="kv">
          <dt>Name</dt><dd>{profile.full_name}</dd>
          <dt>Role</dt><dd>{ROLE_LABEL[profile.role]}</dd>
          <dt>Email</dt><dd className="truncate">{dash(profile.email)}</dd>
          <dt>Phone</dt><dd className="mono">{dash(profile.phone)}</dd>
          <dt>Agent code</dt><dd className="mono">{dash(profile.agent_code)}</dd>
          <dt>Skills</dt><dd>{profile.skills?.length ? profile.skills.join(', ') : '–'}</dd>
          {!admin && <><dt>MyOperator user</dt><dd className="mono">{dash(profile.myoperator_user_id)}</dd>
            <dt>Extension</dt><dd className="mono">{dash(profile.myoperator_extension)}</dd></>}
        </dl>
        {admin ? (
          <div className="form-grid mt-16">
            <Field label="MyOperator user id"><Input className="mono" value={f.myoperator_user_id} onChange={(e) => setF({ ...f, myoperator_user_id: e.target.value })} /></Field>
            <Field label="Extension"><Input className="mono" value={f.myoperator_extension} onChange={(e) => setF({ ...f, myoperator_extension: e.target.value })} /></Field>
            <div className="span2"><Button size="sm" kind="primary" onClick={save} disabled={busy}>Save</Button></div>
          </div>
        ) : <div className="tiny faint mt-12">Role, agent code and MyOperator ids are set by the platform admin. Ask your supervisor if they are wrong; click-to-call rings the MyOperator user above.</div>}
      </Panel>
      <MfaPanel />
    </div>
  );
}

function MfaPanel() {
  const toast = useToast();
  const [run, busy] = useAction();
  const [factors, setFactors] = useState(null);
  const [enroll, setEnroll] = useState(null); // {id, qr, secret}
  const [code, setCode] = useState('');
  const live = !isDemo && supabase;

  const load = async () => {
    if (!live) { setFactors([]); return; }
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) { toast.error(error.message); setFactors([]); return; }
    setFactors(data?.all || data?.totp || []);
  };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => run(async () => {
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `CareDesk ${new Date().toISOString().slice(0, 10)}` });
    if (error) throw error;
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    setCode('');
  });
  const verify = () => run(async () => {
    const ch = await supabase.auth.mfa.challenge({ factorId: enroll.id });
    if (ch.error) throw ch.error;
    const v = await supabase.auth.mfa.verify({ factorId: enroll.id, challengeId: ch.data.id, code: code.trim() });
    if (v.error) throw v.error;
    setEnroll(null);
    await load();
  }, 'Authenticator app linked');
  const cancel = () => run(async () => { if (enroll) await supabase.auth.mfa.unenroll({ factorId: enroll.id }); setEnroll(null); await load(); });
  const remove = (id) => run(async () => { const { error } = await supabase.auth.mfa.unenroll({ factorId: id }); if (error) throw error; await load(); }, 'Factor removed');
  const verified = (factors || []).filter((x) => x.status === 'verified');

  return (
    <Panel title="Two-factor authentication" sub="Authenticator app (TOTP) for this sign-in"
      actions={verified.length ? <Badge kind="ok" dot>On</Badge> : <Badge kind="warn" dot>Off</Badge>}>
      {isDemo && <div className="badge info mb-12" style={{ height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }}>Demo mode has no sign-in server, so the flow below is shown but disabled. In production it uses Supabase Auth MFA.</div>}
      {factors === null ? <Skeleton lines={3} /> : enroll ? (
        <div className="col gap-12">
          <div className="small">1. Scan the code with Google Authenticator, Microsoft Authenticator or similar.</div>
          <div className="st-qr"><img src={enroll.qr} alt="TOTP QR code" width="168" height="168" /></div>
          <div className="tiny muted">Cannot scan? Enter this key: <span className="mono">{enroll.secret}</span></div>
          <Field label="2. Enter the 6-digit code"><Input className="mono" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
          <div className="row"><Button kind="primary" onClick={verify} disabled={busy || code.length !== 6}>Verify and turn on</Button><Button onClick={cancel} disabled={busy}>Cancel</Button></div>
        </div>
      ) : (
        <div className="col gap-12">
          {(factors || []).length ? (
            <table className="t compact"><tbody>{factors.map((x) => (
              <tr key={x.id}><td>{x.friendly_name || 'Authenticator app'}<div className="tiny muted">added {dateTime(x.created_at)}</div></td>
                <td><Badge kind={x.status === 'verified' ? 'ok' : 'warn'}>{x.status}</Badge></td>
                <td className="right"><Button size="xs" kind="ghost" onClick={() => remove(x.id)} disabled={busy}>Remove</Button></td></tr>
            ))}</tbody></table>
          ) : <div className="small muted">No authenticator linked to this account.</div>}
          <div className="row">
            <Button kind="primary" icon="lock" onClick={start} disabled={!live || busy}>{verified.length ? 'Add another authenticator' : 'Set up authenticator'}</Button>
          </div>
          <div className="tiny faint">After set-up you will be asked for a code at each sign-in. Lost your phone? The platform admin can reset it after verifying you.</div>
        </div>
      )}
    </Panel>
  );
}

// "+918049368621 = Hinduja helpline" lines → { did_numbers: [...], did_labels: {number: label} }
function parseLines(text) {
  const did_numbers = [], did_labels = {};
  for (const line of String(text || '').split(/[\n,]+/)) {
    const [num, ...rest] = line.split('=');
    const d = num.replace(/\D/g, '');
    if (!d) continue;
    // same normalisation as the Worker (normMobile), so labels match stored calls
    const n = d.length === 10 ? '+91' + d : d.length === 11 && d.startsWith('0') ? '+91' + d.slice(1) : '+' + d;
    did_numbers.push(n);
    if (rest.join('=').trim()) did_labels[n] = rest.join('=').trim();
  }
  return { did_numbers, did_labels };
}

// ------------------------------------------------------------------ workspace
function WorkspaceTab() {
  const { workspace, can, reload } = useAuth();
  const cm = can('client_manager');
  const s = workspace?.settings || {};
  const [f, setF] = useState({
    brand_name: workspace?.brand_name || '', support_number: workspace?.support_number || '', support_email: workspace?.support_email || '',
    discount_band_pct: workspace?.discount_band_pct ?? 10, allow_cash: !!s.allow_cash, collection_model: s.collection_model || 'A',
    idle_logout_minutes: s.idle_logout_minutes ?? 30,
    did_lines: (s.did_numbers || []).map((n) => (s.did_labels?.[n] ? `${n} = ${s.did_labels[n]}` : n)).join('\n'),
  });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const band = Number(f.discount_band_pct);
  const save = () => run(async () => {
    const patch = {
      brand_name: f.brand_name.trim(), support_number: f.support_number.trim() || null, support_email: f.support_email.trim() || null,
      settings: { ...s, allow_cash: f.allow_cash, collection_model: f.collection_model, idle_logout_minutes: Math.max(0, Number(f.idle_logout_minutes) || 0), ...parseLines(f.did_lines) },
    };
    if (cm) patch.discount_band_pct = band;
    await q(db.from('workspaces').update(patch).eq('id', workspace.id));
    await reload();
  }, 'Workspace saved');
  if (!workspace) return <Skeleton lines={6} />;
  return (
    <div className="grid g-main-side">
      <Panel title="Workspace" sub={`${workspace.name} · code ${workspace.code} · case numbers ${workspace.code}-YYMMDD-NNNNN`}>
        <div className="form-grid">
          <Field label="Brand name" hint="shown to patients in messages"><Input value={f.brand_name} onChange={set('brand_name')} /></Field>
          <Field label="Timezone"><Input value={workspace.timezone} disabled /></Field>
          <Field label="Support number" hint="{{support_number}}"><Input className="mono" value={f.support_number} onChange={set('support_number')} /></Field>
          <Field label="Support email"><Input type="email" value={f.support_email} onChange={set('support_email')} /></Field>
          <Field label="Discount band %" hint={cm ? 'Hinduja policy' : 'set by Hinduja management'}>
            <Input type="number" min="0" max="100" step="0.5" value={f.discount_band_pct} onChange={set('discount_band_pct')} disabled={!cm} className="mono" />
          </Field>
          <Field label="Payment collection model">
            <Select value={f.collection_model} onChange={set('collection_model')} options={[['A', 'A: patient pays into Hinduja gateway'], ['B', 'B: SecondMedic collects and remits']]} />
          </Field>
          <Field label="MyOperator lines" hint="one per line: number = label · routes inbound calls here and tags each call with its line" className="span2">
            <Textarea className="mono" rows={3} value={f.did_lines} onChange={set('did_lines')} placeholder={'+918049368621 = Hinduja helpline'} />
          </Field>
          <Field label="Auto sign-out after idle (minutes)" hint="0 turns it off · wall-screen dashboards may need a longer value">
            <Input type="number" min="0" max="480" className="mono" value={f.idle_logout_minutes} onChange={set('idle_logout_minutes')} />
          </Field>
          <div className="span2"><Check label="Allow cash collection by field staff" checked={f.allow_cash} onChange={set('allow_cash')} /></div>
        </div>
        <div className="row mt-16"><Button kind="primary" onClick={save} disabled={busy || !f.brand_name.trim() || !(band >= 0 && band <= 100)}>Save workspace</Button></div>
      </Panel>
      <Panel title="How these settings act">
        <ul className="au-list small">
          <li><strong>Discount band:</strong> any quote discount above {band || 0}% is blocked and sent to Hinduja management for approval before the quote can go out.</li>
          <li><strong>Cash:</strong> when off, the payment step only accepts UPI, payment link or card, so every rupee has a gateway reference.</li>
          <li><strong>Collection model:</strong> the payment collection model agreed in the contract, kept here as the reference for billing and reconciliation.</li>
          <li><strong>Lines:</strong> MyOperator numbers whose calls are routed to this workspace. The label (for example Khar or Mahim) shows on the incoming-call pop-up and in call reports.</li>
        </ul>
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ templates & scripts
const VARS = ['{{patient_name}}', '{{caller_name}}', '{{case_no}}', '{{services}}', '{{subtotal}}', '{{discount}}', '{{total}}', '{{slot}}', '{{brand}}', '{{support_number}}'];

function TemplatesTab() {
  const { can } = useAuth();
  const editor = can('supervisor', 'admin');
  const [kind, setKind] = useState('');
  const [open, setOpen] = useState(null);
  const [showRetired, setShowRetired] = useState(false);
  const t = useLoad(() => q(db.from('templates').select('*').order('code').order('version', { ascending: false })), [], ['templates', 'approvals']);
  const all = t.data || [];
  const rows = all.filter((x) => (!kind || x.kind === kind) && (showRetired || x.status !== 'retired'));
  const maxVer = (code) => Math.max(0, ...all.filter((x) => x.code === code).map((x) => x.version));
  const current = open && all.find((x) => x.id === open.id);
  return (
    <div className="grid g-main-side">
      <Panel tight title={<Segmented value={kind} onChange={setKind} options={[['', 'All'], ['script', 'Scripts'], ['whatsapp', 'WhatsApp'], ['sms', 'SMS'], ['email', 'Email']]} />}
        actions={<Check label="Show retired" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />}>
        <ErrorNote error={t.error} />
        {t.loading ? <TableSkeleton rows={10} cols={5} /> : rows.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Code</th><th>Title</th><th>Kind</th><th className="num">Ver.</th><th>Status</th><th>WABA template</th></tr></thead>
            <tbody>{rows.map((x) => (
              <tr key={x.id} className="click" onClick={() => setOpen(x)}>
                <td className="mono small">{x.code}</td>
                <td>{x.title}</td>
                <td className="small">{KIND[x.kind]}</td>
                <td className="num">v{x.version}</td>
                <td><Badge kind={T_STATUS[x.status]}>{x.status}</Badge></td>
                <td className="mono small">{x.kind === 'whatsapp' ? dash(x.provider_template_name) : '–'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No templates for this filter" />}
      </Panel>
      <div className="col gap-12">
        <Panel title="How templates are governed">
          <ul className="au-list small">
            <li>Agents send only <strong>approved</strong> templates; scripts guide the call.</li>
            <li>An edit is a <strong>new version</strong> saved as a draft, then submitted to Hinduja management.</li>
            <li>On approval the previous version is retired automatically.</li>
            <li>WhatsApp templates also need the Meta-approved template name from MyOperator.</li>
          </ul>
        </Panel>
        <Panel title="Variables">
          <div className="row wrap" style={{ gap: 4 }}>{VARS.map((v) => <span key={v} className="badge outline mono">{v}</span>)}</div>
          <div className="tiny faint mt-8">Filled from the case at send time. {'{{services}}'} lists each service with its line price.</div>
        </Panel>
      </div>
      {current && <TemplateDrawer t={current} editor={editor} nextVersion={maxVer(current.code) + 1} onClose={() => setOpen(null)} onOpen={(x) => setOpen(x)} reload={t.reload} />}
    </div>
  );
}

function TemplateDrawer({ t, editor, nextVersion, onClose, onOpen, reload }) {
  const { profile } = useAuth();
  const [mode, setMode] = useState('view'); // view | new | edit
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { setMode('view'); setF(null); }, [t.id]);
  const begin = (m) => { setMode(m); setF({ title: t.title, body: t.body, provider_template_name: t.provider_template_name || '' }); };
  const save = () => run(async () => {
    const row = { title: f.title.trim(), body: f.body, provider_template_name: f.provider_template_name.trim() || null };
    if (mode === 'edit') {
      const [x] = await q(db.from('templates').update(row).eq('id', t.id).select());
      await reload(); setMode('view'); onOpen(x);
    } else {
      const [x] = await q(db.from('templates').insert({ ...row, workspace_id: profile.workspace_id, kind: t.kind, code: t.code, version: nextVersion, status: 'draft', created_by: profile.id }).select());
      await reload(); setMode('view'); onOpen(x);
    }
  }, 'Draft saved');
  const submit = () => run(async () => { await rpc('submit_template', { p_template: t.id }); await reload(); }, 'Submitted to Hinduja management for approval');
  const insertVar = (v) => setF((x) => ({ ...x, body: x.body + v }));

  return (
    <Drawer title={<span>{t.code} · v{mode === 'new' ? nextVersion : t.version} <Badge kind={T_STATUS[mode === 'new' ? 'draft' : t.status]}>{mode === 'new' ? 'new draft' : t.status}</Badge></span>} onClose={onClose}
      footer={editor && (mode === 'view' ? <>
        {t.status === 'draft' && <Button icon="edit" onClick={() => begin('edit')}>Edit draft</Button>}
        {t.status === 'draft' && <Button kind="primary" icon="stamp" onClick={submit} disabled={busy}>Submit for approval</Button>}
        {t.status !== 'draft' && <Button kind="primary" icon="plus" onClick={() => begin('new')}>New version</Button>}
      </> : <>
        <Button onClick={() => setMode('view')}>Cancel</Button>
        <Button kind="primary" onClick={save} disabled={busy || !f?.title.trim() || !f?.body.trim()}>Save draft</Button>
      </>)}>
      {mode === 'view' ? (
        <div className="col gap-12">
          <div><div className="strong">{t.title}</div><div className="small muted">{KIND[t.kind]} · created {dateTime(t.created_at)}{t.approved_at ? ` · approved ${dateTime(t.approved_at)}` : ''}</div></div>
          {t.kind === 'whatsapp' && <div className="small">WABA template name: <span className="mono">{dash(t.provider_template_name)}</span></div>}
          <div className="tl-body"><div className="b st-body">{t.body}</div></div>
          {t.status === 'pending' && <div className="small muted">Waiting for Hinduja management in Approvals. It cannot be edited while pending.</div>}
          {t.status === 'retired' && <div className="small muted">Retired: replaced by a later approved version.</div>}
          {!editor && <div className="tiny faint">Only the supervisor or platform admin can draft new versions.</div>}
        </div>
      ) : (
        <div className="col gap-12">
          {mode === 'new' && <div className="small muted">Creates v{nextVersion} as a draft. v{t.version} stays live until the new version is approved.</div>}
          <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          {t.kind === 'whatsapp' && <Field label="WABA template name" hint="exact name approved in MyOperator / Meta"><Input className="mono" value={f.provider_template_name} onChange={(e) => setF({ ...f, provider_template_name: e.target.value })} /></Field>}
          <Field label="Body"><Textarea rows={12} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <div><div className="upper mb-8">Insert variable</div><div className="row wrap" style={{ gap: 4 }}>{VARS.map((v) => <Button key={v} size="xs" className="mono" onClick={() => insertVar(v)}>{v}</Button>)}</div></div>
        </div>
      )}
    </Drawer>
  );
}

// ------------------------------------------------------------------ SLA policies
function SlaTab() {
  const { can } = useAuth();
  const editor = can('supervisor', 'admin', 'client_manager');
  const pol = useLoad(() => q(db.from('sla_policies').select('*').order('target_minutes')), [], ['sla_policies']);
  const [draft, setDraft] = useState({});
  const [run, busy] = useAction();
  const val = (p, k) => (draft[p.id]?.[k] !== undefined ? draft[p.id][k] : p[k]);
  const set = (p, k, v) => setDraft((d) => ({ ...d, [p.id]: { ...d[p.id], [k]: v } }));
  const save = (p) => run(async () => {
    const d = draft[p.id];
    const patch = { ...d };
    if (patch.target_minutes !== undefined) patch.target_minutes = Number(patch.target_minutes);
    await q(db.from('sla_policies').update(patch).eq('id', p.id));
    setDraft((x) => { const n = { ...x }; delete n[p.id]; return n; });
    pol.reload();
  }, 'SLA policy saved');
  return (
    <Panel tight title="SLA policies" sub="Draft matrix from the proposal · targets are for joint finalisation with Hinduja">
      <ErrorNote error={pol.error} />
      {pol.loading ? <TableSkeleton rows={10} cols={6} /> : pol.data?.length ? (
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Policy</th><th>Measured by</th><th>Target (min)</th><th>Escalate to</th><th>Penalty</th>{editor && <th />}</tr></thead>
          <tbody>{pol.data.map((p) => {
            const dirty = !!draft[p.id];
            const tm = Number(val(p, 'target_minutes'));
            return (
              <tr key={p.id}>
                <td><div>{p.label}</div><div className="tiny muted mono">{p.key}</div></td>
                <td className="small muted">{dash(p.measured_by)}</td>
                <td>{editor ? <div className="row" style={{ gap: 6 }}><Input type="number" min="0" className="input sm mono" style={{ width: 84 }} value={val(p, 'target_minutes')} onChange={(e) => set(p, 'target_minutes', e.target.value)} /><span className="tiny muted nowrap">{mins(tm)}</span></div> : <span className="mono">{mins(p.target_minutes)}</span>}</td>
                <td>{editor ? <Select className="sm" style={{ width: 170 }} value={val(p, 'escalate_to')} onChange={(e) => set(p, 'escalate_to', e.target.value)} options={['coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'].map((r) => [r, ROLE_LABEL[r]])} /> : ROLE_LABEL[p.escalate_to]}</td>
                <td>{editor ? <Check label="" checked={!!val(p, 'penalty')} onChange={(e) => set(p, 'penalty', e.target.checked)} aria-label="Penalty applies" /> : p.penalty ? <Badge kind="warn">Penalty</Badge> : '–'}</td>
                {editor && <td className="right nowrap">{dirty && <><Button size="xs" kind="ghost" onClick={() => setDraft((x) => { const n = { ...x }; delete n[p.id]; return n; })}>Reset</Button> <Button size="xs" kind="primary" onClick={() => save(p)} disabled={busy || !(tm >= 0)}>Save</Button></>}</td>}
              </tr>
            );
          })}</tbody>
        </table></div>
      ) : <Empty title="No SLA policies configured" />}
      <div className="small muted" style={{ padding: '10px 12px' }}>Timers start and stop from system timestamps (telephony, quote sent, geo-tagged check-in), never from manual entry. Changes apply to timers started after saving.</div>
    </Panel>
  );
}

// ------------------------------------------------------------------ escalation matrix
function EscalationTab() {
  const { can } = useAuth();
  const editor = can('supervisor', 'admin', 'client_manager');
  const m = useLoad(() => q(db.from('escalation_matrix').select('*').order('type').order('level')), [], ['escalation_matrix']);
  const [edit, setEdit] = useState(null);
  const groups = Object.keys(ESC_TYPE).map((t) => [t, (m.data || []).filter((x) => x.type === t)]).filter(([, r]) => r.length);
  return (
    <>
      <Panel tight title="Escalation matrix" sub="Who is contacted at each level, and how fast">
        <ErrorNote error={m.error} />
        {m.loading ? <TableSkeleton rows={12} cols={6} /> : groups.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Type</th><th>Level</th><th>Owner</th><th>Contact</th><th>Phone</th><th>Email</th><th>Within</th>{editor && <th />}</tr></thead>
            <tbody>{groups.map(([type, rows]) => rows.map((r, i) => (
              <tr key={r.id}>
                <td>{i === 0 ? <Badge kind={['clinical', 'emergency'].includes(type) ? 'danger' : type === 'privacy' ? 'plum' : 'warn'}>{ESC_TYPE[type]}</Badge> : ''}</td>
                <td className="mono">L{r.level}</td>
                <td className="small">{r.owner_label}</td>
                <td className="small">{r.contact_name || <span className="warn-text">Not named</span>}</td>
                <td className="mono small">{dash(r.contact_phone)}</td>
                <td className="small truncate" style={{ maxWidth: 180 }}>{dash(r.contact_email)}</td>
                <td className="mono small">{mins(r.target_minutes)}</td>
                {editor && <td className="right"><Button size="xs" onClick={() => setEdit(r)}>Edit</Button></td>}
              </tr>
            )))}</tbody>
          </table></div>
        ) : <Empty title="No escalation matrix configured" />}
      </Panel>
      {edit && <EscEdit r={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); m.reload(); }} />}
    </>
  );
}

function EscEdit({ r, onClose, onSaved }) {
  const [f, setF] = useState({ contact_name: r.contact_name || '', contact_phone: r.contact_phone || '', contact_email: r.contact_email || '', target_minutes: r.target_minutes ?? '' });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = () => run(async () => {
    await q(db.from('escalation_matrix').update({ contact_name: f.contact_name.trim() || null, contact_phone: f.contact_phone.trim() || null, contact_email: f.contact_email.trim() || null,
      target_minutes: f.target_minutes === '' ? null : Number(f.target_minutes) }).eq('id', r.id));
    onSaved();
  }, 'Escalation contact saved');
  return (
    <Modal title={`${ESC_TYPE[r.type]} · level ${r.level}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save} disabled={busy}>Save</Button></>}>
      <div className="small muted mb-12">{r.owner_label}</div>
      <div className="form-grid">
        <Field label="Contact name" className="span2"><Input value={f.contact_name} onChange={set('contact_name')} /></Field>
        <Field label="Phone"><Input className="mono" value={f.contact_phone} onChange={set('contact_phone')} /></Field>
        <Field label="Email"><Input type="email" value={f.contact_email} onChange={set('contact_email')} /></Field>
        <Field label="Target minutes" hint="0 = immediate, blank = per DPA"><Input type="number" min="0" className="mono" value={f.target_minutes} onChange={set('target_minutes')} /></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ zones
function ZonesTab() {
  const z = useLoad(() => q(db.from('zones').select('*').order('name')), [], ['zones']);
  const [edit, setEdit] = useState(null);
  return (
    <div className="grid g-main-side">
      <Panel tight title="Service zones" actions={<Button size="sm" icon="plus" onClick={() => setEdit({})}>Add zone</Button>}>
        <ErrorNote error={z.error} />
        {z.loading ? <TableSkeleton rows={5} cols={4} /> : z.data?.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Zone</th><th className="num">Pincodes</th><th>Pincode list</th><th>Status</th><th /></tr></thead>
            <tbody>{z.data.map((x) => (
              <tr key={x.id}>
                <td className="strong">{x.name}</td>
                <td className="num">{x.pincodes.length}</td>
                <td className="mono small" style={{ maxWidth: 360, whiteSpace: 'normal' }}>{x.pincodes.join(', ') || '–'}</td>
                <td>{x.active ? <Badge kind="ok">Active</Badge> : <Badge>Inactive</Badge>}</td>
                <td className="right"><Button size="xs" onClick={() => setEdit(x)}>Edit</Button></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No zones yet">Add the first MMR zone with its pincodes.</Empty>}
      </Panel>
      <Panel title="How zones are used">
        <div className="small">A patient's pincode sets the zone automatically. Zones drive dispatch, the live dashboard geography and the MIS zone table. Unmapped pincodes are flagged on the patient and case.</div>
      </Panel>
      {edit && <ZoneEdit z={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); z.reload(); }} />}
    </div>
  );
}

function ZoneEdit({ z, onClose, onSaved }) {
  const { profile } = useAuth();
  const [name, setName] = useState(z.name || '');
  const [pins, setPins] = useState((z.pincodes || []).join(', '));
  const [active, setActive] = useState(z.active ?? true);
  const [run, busy] = useAction();
  const parsed = list(pins);
  const bad = parsed.filter((p) => !/^\d{6}$/.test(p));
  const save = () => run(async () => {
    const row = { name: name.trim(), pincodes: [...new Set(parsed)], active };
    if (z.id) await q(db.from('zones').update(row).eq('id', z.id));
    else await q(db.from('zones').insert({ ...row, workspace_id: profile.workspace_id }));
    onSaved();
  }, 'Zone saved');
  return (
    <Modal title={z.id ? `Edit zone · ${z.name}` : 'Add zone'} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save} disabled={busy || !name.trim() || bad.length > 0}>Save zone</Button></>}>
      <div className="col gap-12">
        <Field label="Zone name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Borivali" /></Field>
        <Field label="Pincodes" hint={bad.length ? `invalid: ${bad.join(', ')}` : `${parsed.length} · comma separated`}><Textarea className="mono" value={pins} onChange={(e) => setPins(e.target.value)} placeholder="400091, 400092, 400103" /></Field>
        <Check label="Active" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <div className="tiny faint">Existing patients keep their zone until their pincode is edited.</div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ users
function UsersTab() {
  const { can } = useAuth();
  const admin = can('admin');
  const sup = can('supervisor');
  const [tel, setTel] = useState(null);
  const [role, setRole] = useState('');
  const [add, setAdd] = useState(false);
  const [edit, setEdit] = useState(null);
  const u = useLoad(() => q(db.from('profiles').select('*').order('role').order('full_name')), [], ['profiles']);
  const prov = useLoad(() => q(db.from('providers').select('id,code,name').order('code', { ascending: false })), []);
  const provName = (id) => (prov.data || []).find((p) => p.id === id)?.name;
  const rows = (u.data || []).filter((x) => !role || x.role === role);
  return (
    <>
      <Panel tight title={<Select value={role} onChange={(e) => setRole(e.target.value)} placeholder="All roles" options={ALL.map((r) => [r, ROLE_LABEL[r]])} style={{ width: 200 }} />}
        actions={<>{<span className="small muted">{rows.length} users</span>}{admin && <Button size="sm" kind="primary" icon="plus" onClick={() => setAdd(true)}>Add user</Button>}</>}>
        <ErrorNote error={u.error} />
        {u.loading ? <TableSkeleton rows={10} cols={8} /> : rows.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Name</th><th>Role</th><th>Agent code</th><th>MyOperator user</th><th>Ext.</th><th>Skills</th><th>On duty</th><th>Status</th>{(admin || sup) && <th />}</tr></thead>
            <tbody>{rows.map((x) => (
              <tr key={x.id} className={x.active ? '' : 'muted'}>
                <td><div>{x.full_name}</div><div className="tiny muted">{x.email || x.phone || '–'}</div></td>
                <td className="small nowrap">{ROLE_LABEL[x.role]}{x.provider_id && <div className="tiny muted">{provName(x.provider_id)}</div>}</td>
                <td className="mono small">{dash(x.agent_code)}</td>
                <td className="mono small">{dash(x.myoperator_user_id)}</td>
                <td className="mono small">{dash(x.myoperator_extension)}</td>
                <td className="small">{x.skills?.length ? x.skills.join(', ') : '–'}</td>
                <td>{x.on_duty ? <Badge kind="ok" dot>On</Badge> : <span className="small muted">Off</span>}</td>
                <td>{x.active ? <Badge kind="ok">Active</Badge> : <Badge>Disabled</Badge>}</td>
                {admin && <td className="right"><Button size="xs" onClick={() => setEdit(x)}>Edit</Button></td>}
                {!admin && sup && <td className="right"><Button size="xs" onClick={() => setTel(x)}>Telephony</Button></td>}
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No users for this role" />}
      </Panel>
      {!admin && <div className="small muted mt-8">{sup ? 'Supervisors set each login\'s MyOperator user id, extension and phone (Telephony). ' : 'Read-only. '}The platform admin creates users and changes roles; quarterly access reviews use this list.</div>}
      {tel && <TelephonyForm u={tel} onClose={() => setTel(null)} onSaved={() => { setTel(null); u.reload(); }} />}
      {add && <UserForm providers={prov.data || []} onClose={() => setAdd(false)} onSaved={() => { setAdd(false); u.reload(); }} />}
      {edit && <UserForm providers={prov.data || []} u={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); u.reload(); }} />}
    </>
  );
}

// ------------------------------------------------------------------ departments & staff (platform admin and supervisors)
// A department is a login role (profiles.role): pick one to see exactly the staff in it. Partner staff (role provider)
// are split by partner. Counts are of active logins; disabled logins are listed only when asked for. Same rights as Users:
// the admin edits logins (role, status); a supervisor sets a login's MyOperator telephony only.
const CALLING = ['agent', 'coordinator', 'supervisor', 'medical_desk'];   // need a MyOperator user to place calls

function DepartmentsTab() {
  const { can, switchUser } = useAuth();
  const nav = useNavigate();
  const admin = can('admin');
  const [openStaff, staffBusy] = useAction();
  const [tel, setTel] = useState(null);
  const [sp, setSp] = useSearchParams();
  const dept = DEPARTMENTS.some(([k]) => k === sp.get('dept')) ? sp.get('dept') : 'agent';
  const pick = (k) => setSp({ tab: 'departments', dept: k }, { replace: true });
  const [find, setFind] = useState('');
  const [disabled, setDisabled] = useState(false);
  const [partner, setPartner] = useState('');
  const [edit, setEdit] = useState(null);
  const u = useLoad(() => q(db.from('profiles').select('id,full_name,email,phone,role,agent_code,myoperator_user_id,myoperator_extension,zone_id,skills,on_duty,available,active,last_seen_at,provider_id,created_at')
    .order('full_name')), [], ['profiles']);
  const prov = useLoad(() => q(db.from('providers').select('id,code,name').order('code', { ascending: false })), []);
  const zones = useLoad(() => q(db.from('zones').select('id,name').order('name')), []);
  const zoneName = (id) => (zones.data || []).find((z) => z.id === id)?.name;
  const provName = (id) => (prov.data || []).find((p) => p.id === id)?.name;
  const all = u.data || [];
  const count = (role) => {
    const rs = all.filter((x) => x.role === role);
    return { active: rs.filter((x) => x.active).length, off: rs.filter((x) => !x.active).length };
  };
  const [, title, about] = DEPARTMENTS.find(([k]) => k === dept);
  const needle = find.trim().toLowerCase();
  const rows = all.filter((x) => x.role === dept && (disabled || x.active)
    && (dept !== 'provider' || !partner || (partner === 'none' ? !x.provider_id : x.provider_id === partner))
    && (!needle || [x.full_name, x.email, x.phone, x.agent_code].some((v) => String(v || '').toLowerCase().includes(needle))));
  const c = count(dept);
  // "now": field staff use the on-duty switch, everyone else the Available / Away switch in the top bar
  const now = (x) => (!x.active ? null : (dept === 'field_staff' ? x.on_duty : x.available) ? <Badge kind="ok" dot>{dept === 'field_staff' ? 'On duty' : 'Available'}</Badge> : <span className="small muted">{dept === 'field_staff' ? 'Off duty' : 'Away'}</span>);
  const unknown = all.filter((x) => !DEPARTMENTS.some(([k]) => k === x.role));
  return (
    <>
      <div className="dp-grid">
        <Panel tight title="Departments" actions={<span className="small muted">{all.filter((x) => x.active).length} active staff</span>}>
          {u.loading ? <div className="panel-body"><Skeleton lines={9} /></div> : (
            <div role="listbox" aria-label="Departments">
              {DEPARTMENTS.map(([k, label]) => {
                const n = count(k);
                return (
                  <button key={k} type="button" role="option" aria-selected={k === dept} className={`dp-item${k === dept ? ' on' : ''}`} onClick={() => pick(k)}>
                    <span className="grow">{label}{ROLE_LABEL[k] !== label && <span className="tiny muted dp-role">{ROLE_LABEL[k]}</span>}</span>
                    <span className="mono small">{n.active}</span>{n.off > 0 && <span className="tiny muted">+{n.off} off</span>}
                  </button>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel tight title={<div><h3>{title}</h3><div className="tiny muted">{about}</div></div>}
          actions={<span className="small muted">{c.active} active{c.off ? ` · ${c.off} disabled` : ''}</span>}>
          <div className="panel-body row wrap gap-8" style={{ alignItems: 'flex-end', borderBottom: '1px solid var(--line-2)' }}>
            <Input placeholder="Search name, email, phone, code" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 260, maxWidth: '100%' }} aria-label="Search staff" />
            {dept === 'provider' && <Select value={partner} onChange={(e) => setPartner(e.target.value)} placeholder="All partners" style={{ width: 200 }}
              options={[...(prov.data || []).map((p) => [p.id, p.name]), ['none', 'No partner set']]} aria-label="Partner" />}
            <Check label="Show disabled logins" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} />
          </div>
          <ErrorNote error={u.error} />
          {u.loading ? <TableSkeleton rows={6} cols={6} /> : rows.length ? (
            <div className="table-wrap"><table className="t">
              <thead><tr>
                <th>Name</th><th>Agent code</th>
                {CALLING.includes(dept) && <th>MyOperator</th>}
                {dept === 'field_staff' && <><th>Zone</th><th>Skills</th></>}
                {dept === 'provider' && <th>Partner</th>}
                <th>Now</th><th>Last seen</th><th>Status</th><th />
              </tr></thead>
              <tbody>{rows.map((x) => (
                <tr key={x.id} className={x.active ? '' : 'muted'}>
                  <td><div>{x.full_name}</div><div className="tiny muted">{[x.email, x.phone].filter(Boolean).join(' · ') || '–'}</div></td>
                  <td className="mono small">{dash(x.agent_code)}</td>
                  {CALLING.includes(dept) && <td className="small">{x.myoperator_user_id ? <span className="mono">{x.myoperator_user_id}{x.myoperator_extension ? ` · ext ${x.myoperator_extension}` : ''}</span> : <Badge kind="warn">Not linked</Badge>}</td>}
                  {dept === 'field_staff' && <><td className="small">{dash(zoneName(x.zone_id))}</td><td className="small">{x.skills?.length ? x.skills.join(', ') : '–'}</td></>}
                  {dept === 'provider' && <td className="small">{x.provider_id ? dash(provName(x.provider_id)) : <Badge kind="danger">No partner set</Badge>}</td>}
                  <td>{now(x)}</td>
                  <td className="small nowrap">{x.last_seen_at ? ago(x.last_seen_at) : <span className="muted">never</span>}</td>
                  <td>{x.active ? <Badge kind="ok">Active</Badge> : <Badge>Disabled</Badge>}</td>
                  <td className="right">
                    <div className="row gap-4" style={{ justifyContent: 'flex-end' }}>
                      {can('supervisor') && x.active && STAFF_ROLES.includes(x.role) && <Button size="xs" kind="ghost" disabled={staffBusy} onClick={() => openStaff(() => switchUser(x.id))}>Open staff workspace</Button>}
                      {admin ? <Button size="xs" onClick={() => setEdit(x)}>Edit</Button>
                        : x.role !== 'provider' && <Button size="xs" onClick={() => setTel(x)}>Telephony</Button>}
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty title={needle || partner ? 'No staff match' : `No ${disabled ? '' : 'active '}staff in ${title}`}>{admin ? "Add a login in Users, or change a login's role with Edit." : 'The platform admin adds logins and changes roles.'}</Empty>}
        </Panel>
      </div>
      {unknown.length > 0 && <div className="small danger-text mt-8">{unknown.length} login{unknown.length === 1 ? ' has' : 's have'} a role outside these departments: {unknown.map((x) => x.full_name).join(', ')}.</div>}
      <div className="small muted mt-8">{admin ? "Changing a login's role (Edit) moves it to that department and changes what it can see at once." : "Supervisors set each login's MyOperator user id, extension and phone (Telephony); the platform admin adds logins and changes roles."} Every change is in the audit trail.</div>
      {tel && <TelephonyForm u={tel} onClose={() => setTel(null)} onSaved={() => { setTel(null); u.reload(); }} />}
      {edit && <UserForm providers={prov.data || []} u={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); u.reload(); }} />}
    </>
  );
}

function TelephonyForm({ u, onClose, onSaved }) {
  const [f, setF] = useState({ myoperator_user_id: u.myoperator_user_id || '', myoperator_extension: u.myoperator_extension || '', phone: u.phone || '' });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = () => run(async () => { await setTelephony({ profile_id: u.id, ...f }); onSaved(); }, 'Telephony saved');
  return (
    <Modal title={`Telephony · ${u.full_name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="MyOperator user id" hint="MyOperator > Manage > Users > Edit" className="span2"><Input className="mono" value={f.myoperator_user_id} onChange={set('myoperator_user_id')} /></Field>
        <Field label="MyOperator extension" hint="e.g. 11"><Input className="mono" value={f.myoperator_extension} onChange={set('myoperator_extension')} /></Field>
        <Field label="Mobile" hint="the phone MyOperator rings"><Input className="mono" value={f.phone} onChange={set('phone')} placeholder="+91..." /></Field>
      </div>
      <div className="tiny faint mt-12">Click-to-call rings this MyOperator user first, then the patient. Incoming calls are matched to the agent by user id, extension or mobile.</div>
    </Modal>
  );
}

function UserForm({ u, onClose, onSaved, providers = [] }) {
  const isNew = !u;
  const [f, setF] = useState({
    email: u?.email || '', password: '', full_name: u?.full_name || '', role: u?.role || 'agent', phone: u?.phone || '', agent_code: u?.agent_code || '',
    myoperator_user_id: u?.myoperator_user_id || '', myoperator_extension: u?.myoperator_extension || '', skills: (u?.skills || []).join(', '), active: u?.active ?? true,
    provider_id: u?.provider_id || '',
  });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const ok = f.full_name.trim() && (f.role !== 'provider' || f.provider_id) && (!isNew || (/\S+@\S+\.\S+/.test(f.email) && f.password.length >= 10));
  const save = () => run(async () => {
    const base = { full_name: f.full_name.trim(), role: f.role, agent_code: f.agent_code.trim() || null, myoperator_user_id: f.myoperator_user_id.trim() || null,
      myoperator_extension: f.myoperator_extension.trim() || null, skills: list(f.skills), provider_id: ['provider','field_staff'].includes(f.role) ? (f.provider_id || null) : null };
    if (isNew) await createUser({ ...base, email: f.email.trim(), password: f.password, phone: f.phone.trim() || null });
    else await q(db.from('profiles').update({ ...base, phone: f.phone.trim() || null, active: f.active }).eq('id', u.id));
    onSaved();
  }, isNew ? 'User created' : 'User updated');
  return (
    <Modal title={isNew ? 'Add user' : `Edit user · ${u.full_name}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={save} disabled={!ok || busy}>{isNew ? 'Create user' : 'Save'}</Button></>}>
      <div className="form-grid">
        <Field label="Full name" className="span2"><Input value={f.full_name} onChange={set('full_name')} /></Field>
        {isNew && <Field label="Email" hint="sign-in id"><Input type="email" value={f.email} onChange={set('email')} /></Field>}
        {isNew && <Field label="Temporary password" hint="10+ characters"><Input type="text" className="mono" value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>}
        <Field label="Role"><Select value={f.role} onChange={set('role')} options={ALL.map((r) => [r, ROLE_LABEL[r]])} /></Field>
        {['provider','field_staff'].includes(f.role) && <Field label="Provider" hint="Provider: manages leads. Field staff: assigned provider jobs only. Leave empty for SecondMedic field staff."><Select value={f.provider_id} onChange={set('provider_id')} placeholder="Pick provider" options={providers.map((p) => [p.id, p.name])} /></Field>}
        <Field label="Phone"><Input className="mono" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="Agent code" hint="e.g. A-12"><Input className="mono" value={f.agent_code} onChange={set('agent_code')} /></Field>
        <Field label="Skills" hint="phlebotomy, xray, ecg"><Input value={f.skills} onChange={set('skills')} /></Field>
        <Field label="MyOperator user id"><Input className="mono" value={f.myoperator_user_id} onChange={set('myoperator_user_id')} /></Field>
        <Field label="MyOperator extension"><Input className="mono" value={f.myoperator_extension} onChange={set('myoperator_extension')} /></Field>
        {!isNew && <div className="span2"><Check label="Active (unticking blocks sign-in to CareDesk data)" checked={f.active} onChange={set('active')} /></div>}
      </div>
      {isNew && <div className="tiny faint mt-12">Share the temporary password over a separate channel. The user should set up two-factor authentication on first sign-in.</div>}
    </Modal>
  );
}

// ------------------------------------------------------------------ telephony & integrations
const EVENTS = [
  ['Call', ['Call initiated', 'Dial begin', 'Call answered', 'Call ended', 'Call summary', 'Disposition']],
  ['WhatsApp', ['Message received', 'Message sent', 'Message delivered', 'Message read']],
];
// Where each MyOperator value is found in the panel (in.app.myoperator.com, admin login).
const MO_WHERE = {
  webhook_key: 'Made here with Generate key, then pasted into MyOperator',
  company_id: 'APIs & Webhooks › Developer API › Calling API › Manage',
  secret_token: 'APIs & Webhooks › Developer API › Calling API › Manage',
  obd_api_key: 'APIs & Webhooks › Developer API › Calling API › Manage (x-api-key)',
  public_ivr_id: 'Calling API page, or Campaigns / IVR',
  api_token: 'Manage › API Integration, or Developer API',
  caller_id: 'The helpline number, e.g. +918049368621',
  region: 'Only if MyOperator support gives one',
  waba_api_key: 'APIs & Webhooks › Developer API › WhatsApp API › Manage',
  waba_phone_id: 'APIs & Webhooks › Developer API › WhatsApp API › Manage',
};
const okBadge = (r) => (!r ? null : r.ok ? <Badge kind="ok" dot>OK</Badge> : <Badge kind="warn" dot>Check</Badge>);

/** The CRM initiates peer-to-peer calls; the linked agent answers on their registered phone. */
function CallingSetup() {
  return (
    <Panel title="Call directly from CareDesk" sub="Press Call patient or Call back in the CRM. Answer your registered phone, then MyOperator connects the customer.">
      <ol className="st-steps small">
        <li>Ask MyOperator to enable <strong>Calling API access</strong> and a <strong>peer-to-peer user-dial campaign</strong> with <strong>Dial first: Agent</strong> and the business caller ID.</li>
        <li>Save the <strong>Company ID, Secret token, Calling API key and Public IVR ID</strong> above.</li>
        <li>Use <strong>Load MyOperator users</strong> below and link each CRM login to the correct agent. Confirm that their registered phone is available for calls.</li>
        <li>Save, then press <strong>Test connection</strong>. This checks settings and the user API; it does not place a call or verify calling entitlement.</li>
        <li>Open a test patient or case and press <strong>Call patient</strong>. Answer the agent's phone, verify the customer connects, then check the call status and recording.</li>
      </ol>
      <div className="small muted mt-12">No browser extension, vendor pop-up or microphone permission is needed. If calling fails, CareDesk shows the error here in the app. Keep webhooks configured for live status updates.</div>
    </Panel>
  );
}

function WhatsAppSetup() {
  return (
    <Panel title="Two-way WhatsApp Business (WABA) chats" sub="Receive inbound patient enquiries, send approved templates (T-01 to T-08) and reply inside the 24-hour customer care window.">
      <ol className="st-steps small">
        <li>In MyOperator, open <strong>APIs &amp; Webhooks › Developer API › WhatsApp API › Manage</strong> and copy the <strong>WhatsApp API key</strong> and <strong>WhatsApp phone number ID</strong> into the table above.</li>
        <li>Enable <strong>Webhooks v2</strong> for <strong>Message received</strong>, <strong>Message sent</strong>, <strong>Message delivered</strong> and <strong>Message read</strong> pointing to the webhook address below.</li>
        <li>When a patient messages the Hinduja Home Care WhatsApp number, CareDesk matches their mobile, opens a case if none is active, starts the 5-minute acknowledgement SLA timer and shows the thread in <strong>WhatsApp chats</strong>.</li>
        <li>For approved Meta templates, set each template's <strong>Provider template name</strong> under the <strong>Templates &amp; scripts</strong> tab so quotes (T-03) and confirmations (T-04) deliver outside the 24-hour session window.</li>
      </ol>
    </Panel>
  );
}

// Callback auto-dialer (Hinduja MoM, Oct 2026): missed and abandoned callers are called back automatically.
function AutodialPanel() {
  const cfg = useLoad(() => rpc('autodial_settings', {}), [], ['workspaces', 'profiles', 'callbacks']);
  const [f, setF] = useState(null);
  const [run, busy] = useAction();
  useEffect(() => { if (cfg.data && !f) setF({ enabled: cfg.data.enabled, delay: cfg.data.initial_delay_minutes ?? 0, buffer: cfg.data.buffer_minutes, attempts: cfg.data.max_attempts }); }, [cfg.data, f]);
  const save = () => run(async () => {
    await rpc('set_autodial', { p_enabled: f.enabled, p_initial_delay_minutes: Number(f.delay), p_buffer_minutes: Number(f.buffer), p_max_attempts: Number(f.attempts) });
    cfg.reload();
  }, 'Auto-dialer settings saved');
  const d = cfg.data;
  const gap = f ? Math.max(2, Math.round(Number(f.buffer) / Number(f.attempts))) : null;
  return (
    <Panel title="Callback auto-dialer" sub="Missed and abandoned callers are called back automatically: CareDesk rings a free agent who is Available, then MyOperator bridges the patient in.">
      <ErrorNote error={cfg.error} />
      {!f ? <Skeleton lines={3} /> : (
        <div className="col gap-12">
          <Check label="Auto-dial callbacks" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          <div className="form-grid">
            <Field label="First callback delay" hint="Immediate (default), 30, 45 or 60 minutes after the original missed/abandoned call ended">
              <Segmented options={[[0, 'Immediate'], [30, '30 min'], [45, '45 min'], [60, '60 min']]} value={Number(f.delay)} onChange={(v) => setF({ ...f, delay: v })} />
            </Field>
            <Field label="Callback/retry window" hint="30, 45 or 60 minutes from first eligibility, so the initial delay does not consume it">
              <Segmented options={[[30, '30 min'], [45, '45 min'], [60, '60 min']]} value={Number(f.buffer)} onChange={(v) => setF({ ...f, buffer: v })} />
            </Field>
            <Field label="Maximum attempts" hint={`retry eligibility is spaced about ${gap} min apart, within the deadline`}>
              <Select value={f.attempts} onChange={(e) => setF({ ...f, attempts: e.target.value })} options={[1, 2, 3, 4, 5].map((n) => [n, String(n)])} />
            </Field>
          </div>
          <div className="small muted">
            {d.calling_configured === false && <div className="warn-text">Calling configuration is incomplete. The auto-dialer leaves callbacks pending without creating calls.</div>}
            {d.agents_available} of {d.agents_linked} linked agents marked Available in CRM · {d.queue_waiting} waiting · {d.queue_dialling} dialling · {d.queue_awaiting_outcome} need an outcome.
            {' '}The first attempt is eligible after the initial delay counted from the original call's end time (falling back to queue-creation time when that timestamp is unavailable), is never dialled before then, and starts on a scheduler run when an eligible agent is free. The retry window and deadline start at first eligibility, so the delay does not consume them. The scheduler checks once per minute; connection within the window is not guaranteed. The linked agent phone rings first, then MyOperator connects the customer (the MyOperator campaign must use Agent first). Customer connection marks Reached and moves the callback to Needs outcome. Record a closing outcome to mark Done. Expired items retain the existing Unreachable status with the actual reason, including no eligible agent. CRM Available does not verify MyOperator live availability; a busy or rejected dial is handled as a failed attempt.
          </div>
          <div><Button size="sm" kind="primary" disabled={busy} onClick={save}>Save</Button></div>
        </div>
      )}
    </Panel>
  );
}

function MyOperatorConnection() {
  const toast = useToast();
  const s = useLoad(() => moSettings(), []);
  const [vals, setVals] = useState({});
  const [test, setTest] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [confirmKey, setConfirmKey] = useState(false);
  const [run, busy] = useAction();
  const copy = (t) => navigator.clipboard?.writeText(t).then(() => toast('Copied'), () => toast.error('Copy failed'));
  const changed = Object.keys(vals).length > 0;
  const save = () => run(async () => {
    await saveMoSettings({ values: vals });
    setVals({}); setTest(null); s.reload();
  }, 'MyOperator details saved');
  const runTest = () => run(async () => setTest(await testMo()));
  const genKey = () => run(async () => { await saveMoSettings({ generate_webhook_key: true }); setConfirmKey(false); setShowKey(true); s.reload(); }, 'New webhook key made. Update it in MyOperator.');
  const d = s.data;
  const wh = d?.webhook || {};
  const hookUrl = wh.url_with_key || wh.url || '';
  const shownUrl = showKey ? hookUrl : (wh.url_with_key ? wh.url + '?key=••••••' : wh.url);
  return (
    <div className="col gap-12">
      <Panel title="MyOperator connection" sub="Values saved here are used at once; nothing to deploy. Saved credentials are never shown again, only their last 4 characters."
        actions={<><Button size="sm" kind="ghost" icon="refresh" onClick={runTest} disabled={busy || d?.demo}>Test connection</Button>
          <Button size="sm" kind="primary" onClick={save} disabled={!changed || busy}>Save</Button></>}>
        <ErrorNote error={s.error} />
        {d?.demo && <div className="small muted mb-8">Demo mode: MyOperator connects on the live site.</div>}
        {test && (
          <table className="t compact mb-12"><tbody>
            {[['api', 'API token'], ['click_to_call', 'Calling settings'], ['whatsapp', 'WhatsApp (WABA)'], ['webhook', 'Webhook']].map(([k, l]) => (
              <tr key={k}><td className="small strong nowrap">{l}</td><td>{okBadge(test[k])}</td><td className="small">{test[k]?.message}</td></tr>
            ))}
          </tbody></table>
        )}
        {s.loading ? <TableSkeleton rows={6} cols={3} /> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Detail</th><th>Where to find it</th><th>Now</th><th style={{ minWidth: 220 }}>New value</th></tr></thead>
            <tbody>{(d?.fields || []).filter((f) => f.key !== 'webhook_key').map((f) => (
              <tr key={f.key}>
                <td className="small strong">{f.label}</td>
                <td className="tiny muted">{MO_WHERE[f.key]}</td>
                <td className="nowrap">{f.set ? <><span className="mono small">{f.value}</span> <Badge kind={f.source === 'app' ? 'ok' : 'info'}>{f.source === 'app' ? 'Saved here' : 'GitHub secret'}</Badge></> : <Badge kind="warn">Not set</Badge>}
                  {f.source === 'app' && <Button size="xs" kind="ghost" onClick={() => setVals((v) => ({ ...v, [f.key]: '' }))}>Clear</Button>}</td>
                <td><Input className="mono" type={f.secret ? 'password' : 'text'} autoComplete="off" placeholder={vals[f.key] === '' ? 'Will be cleared' : f.set ? 'Paste to replace' : 'Paste here'}
                  value={vals[f.key] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <div className="tiny faint mt-8">If Calling API › Manage is locked in MyOperator, ask MyOperator support to enable the Calling API and Webhooks v2 for the account.</div>
      </Panel>
      <CallingSetup />
      <WhatsAppSetup />

      <Panel title="Calls into the CRM (webhooks)" sub="Add these in MyOperator so incoming calls pop up for the agent, and ended calls, missed calls and recordings reach the case."
        actions={<Button size="sm" onClick={() => setConfirmKey(true)} disabled={busy || d?.demo}>{wh.key ? 'New key' : 'Generate key'}</Button>}>
        {s.loading ? <Skeleton lines={4} /> : !wh.key ? (
          <Empty title="No webhook key yet">Press Generate key. MyOperator sends the key with every call event, so only MyOperator can post calls into the CRM.</Empty>
        ) : (
          <ol className="st-steps small">
            <li>Webhook address (the key is part of it)
              <div className="row mt-4"><code className="st-code grow">{shownUrl}</code>
                <Button size="xs" kind="ghost" onClick={() => setShowKey((x) => !x)}>{showKey ? 'Hide' : 'Show'}</Button>
                <Button size="xs" onClick={() => copy(hookUrl)}>Copy</Button></div></li>
            <li><strong>Live pop-up:</strong> MyOperator › APIs & Webhooks › Calling Webhooks › Add new. Type <strong>InCall</strong>, method POST, content type JSON, URL as above.</li>
            <li><strong>Call end and recording:</strong> add a second one the same way with type <strong>AfterCall</strong>.</li>
            <li><strong>Webhooks v2</strong> (once MyOperator support enables it): URL <code className="st-code">{wh.url}</code>, header <code className="st-code">x-webhook-key</code> = the key
              <Button size="xs" kind="ghost" onClick={() => copy(wh.key)}>Copy key</Button>; events:
              {EVENTS.map(([g, ev]) => <div key={g} className="mt-4"><span className="upper">{g}</span> <span className="row wrap" style={{ gap: 4, display: 'inline-flex' }}>{ev.map((e) => <Badge key={e} kind="outline">{e}</Badge>)}</span></div>)}
              Use either v2 or the InCall + AfterCall pair, not both.</li>
            <li>Call the helpline from a mobile while an agent is signed in. The call shows on the agent's screen and in the event log below.</li>
          </ol>
        )}
        {d?.last_event && <div className="tiny muted mt-8">Last event: {dateTime(d.last_event.received_at)} · <span className="mono">{d.last_event.event_type}</span>{d.last_event.error ? ' · error, see log' : ''}</div>}
      </Panel>

      <CallLogSync sync={d?.sync} hasToken={(d?.fields || []).some((f) => f.key === 'api_token' && f.set)} disabled={d?.demo} onDone={s.reload} />

      <MoUsers agents={d?.agents} disabled={d?.demo} />

      {confirmKey && (
        <Modal title={wh.key ? 'Make a new webhook key?' : 'Generate webhook key'} onClose={() => setConfirmKey(false)}
          footer={<><Button onClick={() => setConfirmKey(false)}>Cancel</Button><Button kind="primary" onClick={genKey} disabled={busy}>{wh.key ? 'Make new key' : 'Generate'}</Button></>}>
          <div className="small">{wh.key ? 'The current key stops working at once. Paste the new address into every MyOperator webhook straight after.' : 'A long random key is made and saved. Then copy the webhook address into MyOperator.'}</div>
        </Modal>
      )}
    </div>
  );
}

function CallLogSync({ sync, hasToken, disabled, onDone }) {
  const [res, setRes] = useState(null);
  const [run, busy] = useAction();
  const go = () => run(async () => { const r = await syncMo(); setRes(r); onDone?.(); });
  const st = sync || {};
  return (
    <Panel title="Call-log sync" sub="Every minute CareDesk reads new calls from MyOperator's call log: calls, missed-call callbacks and recordings reach the right patient and case within about a minute. Works without webhooks; the live ringing pop-up needs webhooks."
      actions={<Button size="sm" onClick={go} disabled={busy || disabled || !hasToken}>{busy ? 'Syncing' : 'Sync now'}</Button>}>
      {!hasToken ? <div className="small warn-text">Needs the API token above (MyOperator › Manage › API Integration › Public API).</div> : (
        <table className="t compact"><tbody>
          <tr><td className="small muted">Status</td><td>{st.last_error ? <Badge kind="danger" dot>Error</Badge> : st.last_ok_at ? <Badge kind="ok" dot>Running every minute</Badge> : <Badge kind="info" dot>Starts within a minute</Badge>}</td></tr>
          <tr><td className="small muted">Last successful run</td><td className="small">{st.last_ok_at ? dateTime(st.last_ok_at) : '–'}</td></tr>
          <tr><td className="small muted">Calls brought in</td><td className="small">{st.total_new ?? 0} in total{st.last_ok_at ? ` · ${st.last_new ?? 0} in the last run` : ''}</td></tr>
          {st.last_error && <tr><td className="small muted">Last error</td><td className="small danger-text">{st.last_error}</td></tr>}
          {st.last_shape && <tr><td className="small muted nowrap">MyOperator answered</td><td className="tiny mono" style={{ wordBreak: 'break-all' }}>{st.last_shape}</td></tr>}
        </tbody></table>
      )}
      {res && <div className={`small mt-8 ${res.ok === false ? 'danger-text' : ''}`}>{res.ok === false ? res.error : res.skipped ? res.skipped : `Read ${res.seen} call log entr${res.seen === 1 ? 'y' : 'ies'} since ${dateTime(res.window_from)}, ${res.new} new, ${res.failed} with errors (see the event log below).`}
        {res.shape && <div className="tiny mono faint mt-4" style={{ wordBreak: 'break-all' }}>{res.shape}</div>}</div>}
    </Panel>
  );
}

function MoUsers({ agents, disabled }) {
  const [data, setData] = useState(null);
  const [run, busy] = useAction();
  const load = () => run(async () => setData(await moUsers()));
  const link = (profileId, moId) => run(async () => { await linkMoUsers({ links: [{ profile_id: profileId, myoperator_user_id: moId || null }] }); setData(await moUsers()); }, 'Saved');
  const auto = () => run(async () => { const r = await linkMoUsers({ auto: true }); setData(await moUsers()); return r; }, 'Linked by email / phone');
  const suggested = (data?.users || []).filter((u) => u.suggested_profile).length;
  const byProfile = (moId) => (data?.profiles || []).find((p) => p.myoperator_user_id === moId)?.id || '';
  return (
    <Panel tight title="Agents in MyOperator" sub={agents ? `${agents.linked} of ${agents.ops} call-centre logins linked. A linked agent gets the pop-up for calls ringing on their phone and can click to call.` : ''}
      actions={<>{data && suggested > 0 && <Button size="sm" kind="primary" onClick={auto} disabled={busy}>Link {suggested} by email / phone</Button>}
        <Button size="sm" onClick={load} disabled={busy || disabled}>{data ? 'Reload' : 'Load MyOperator users'}</Button></>}>
      {!data ? <div className="small muted" style={{ padding: 12 }}>Loads the users on the MyOperator account (needs the API token) so each can be linked to their CareDesk login.</div>
        : data.users.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>MyOperator user</th><th>Email</th><th>Phone</th><th>Ext.</th><th style={{ minWidth: 220 }}>CareDesk login</th></tr></thead>
            <tbody>{data.users.map((u) => (
              <tr key={u.id}>
                <td className="small strong">{u.name || '–'}<div className="tiny faint mono">{u.id}</div></td>
                <td className="small">{u.email || '–'}</td>
                <td className="small mono nowrap">{u.phone || '–'}</td>
                <td className="small mono">{u.extension || '–'}</td>
                <td><Select value={byProfile(u.id)} onChange={(e) => link(e.target.value || byProfile(u.id), e.target.value ? u.id : null)} disabled={busy}
                  placeholder={u.suggested_name ? `Suggested: ${u.suggested_name}` : 'Not linked'}
                  options={data.profiles.map((p) => [p.id, `${p.full_name} · ${ROLE_LABEL[p.role] || p.role}`])} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No users on the MyOperator account">Add the agents in MyOperator first.</Empty>}
    </Panel>
  );
}

/** AI call summaries: the Gemini key, model and auto switch (saved in the app, used at once), and how recorded calls stand. */
function AiSummaries({ onSaved }) {
  const s = useLoad(() => aiSettings(), [], ['calls']);
  const [key, setKey] = useState('');
  const [model, setModel] = useState(null);
  const [test, setTest] = useState(null);
  const [run, busy] = useAction();
  const d = s.data;
  const save = (body, msg) => run(async () => { await saveAiSettings(body); setKey(''); setModel(null); setTest(null); s.reload(); onSaved?.(); }, msg);
  const runTest = () => run(async () => setTest(await testAi()));
  const st = d?.stats || {};
  return (
    <Panel title="AI call summaries" sub="Gemini 3.5 Transcribe Live captures speech during calls. When the call ends, the summary model writes a summary, intent, sentiment, red flags and a QA score. Calls without a finished live transcript use the MyOperator recording."
      actions={<Button size="sm" kind="ghost" icon="refresh" onClick={runTest} disabled={busy || !d?.key?.set}>Test key</Button>}>
      <ErrorNote error={s.error} />
      {s.loading ? <Skeleton lines={4} /> : d && (
        <div className="col gap-12">
          {d.demo && <div className="small muted">Demo mode: summaries are simulated in the browser. The key is entered on the live site.</div>}
          <div className="row wrap gap-8">
            {d.key.set ? <Badge kind="ok" dot>Key set ({d.key.value}, {d.key.source === 'app' ? 'saved here' : 'Worker secret'})</Badge> : <Badge kind="warn" dot>No Gemini key: summaries are off</Badge>}
            {d.key.set && (d.auto ? <Badge kind="ok" dot>Automatic after each call</Badge> : <Badge kind="info" dot>On request only</Badge>)}
            <Badge kind="outline">Live speech: {d.live_model}</Badge>
            <Badge kind="outline">Summary: {d.model}</Badge>
          </div>
          {test && <div className="row gap-8">{okBadge(test)}<span className="small">{test.message}</span></div>}
          {d.paused && <div className="small danger-text">Automatic summaries paused until {dateTime(d.paused.paused_until)}: {d.paused.reason}</div>}
          <div className="grid g2" style={{ gap: 12 }}>
            <Field label={d.key.set ? 'Replace the Gemini API key' : 'Gemini API key'} hint="Google AI Studio > Get API key, in a Google Cloud project with billing on">
              <Input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" disabled={d.demo} />
            </Field>
            <Field label="Summary model" hint="leave empty for gemini-2.5-flash; the live transcription model is separate">
              <Input value={model ?? (d.model_source === 'app' ? d.model : '')} onChange={(e) => setModel(e.target.value)} placeholder="gemini-2.5-flash" disabled={d.demo} />
            </Field>
          </div>
          <div className="row wrap gap-8">
            <Button kind="primary" disabled={busy || d.demo || (!key.trim() && model == null)} onClick={() => save({ ...(key.trim() ? { api_key: key.trim() } : {}), ...(model != null ? { model: model.trim() } : {}) }, 'AI settings saved')}>Save</Button>
            {d.key.set && <Check label="Summarise finished calls automatically" checked={d.auto} disabled={busy || d.demo} onChange={(e) => save({ auto: e.target.checked }, e.target.checked ? 'Automatic summaries on' : 'Summaries only on request')} />}
            {d.key.source === 'app' && <Button kind="ghost" disabled={busy} onClick={() => save({ api_key: '' }, 'Key removed')}>Remove saved key</Button>}
          </div>
          <div className="small">
            Last 14 days of calls with audio or a live transcript: <strong>{st.done ?? 0}</strong> summarised · <strong>{st.waiting ?? 0}</strong> waiting · <strong className={st.failed ? 'danger-text' : ''}>{st.failed ?? 0}</strong> failed · {st.skipped ?? 0} too short.
            {' '}Waiting calls are done one a minute, newest first; a failed call is retried up to 3 times.
          </div>
          {d.last_error && <div className="small danger-text">Last failure ({ago(d.last_error.ai_started_at)}): {d.last_error.ai_error}</div>}
          {d.key.set && (st.failed > 0 || d.paused) && <div><Button size="sm" icon="refresh" disabled={busy || d.demo} onClick={() => save({ retry_failed: true }, 'Failed calls queued again')}>Retry failed calls</Button>
            <span className="tiny muted"> after fixing the key or billing: puts the last 14 days' failed calls back in the queue and lifts the pause.</span></div>}
          <details className="small"><summary>Create the Gemini key and start live transcription</summary>
            <ol>
              <li>Open <a href="https://aistudio.google.com/api-keys" target="_blank" rel="noreferrer">Google AI Studio API keys</a> and sign in.</li>
              <li>Select or import the Google Cloud project for HHCS-CRM, then choose Create API key.</li>
              <li>For patient calls, use a billing-enabled project. Review Google's API charges before enabling billing.</li>
              <li>Copy the key into the Gemini API key field above, Save, then Test key.</li>
              <li>During an active call, open Live transcript, put the phone on speaker, confirm both people agree, then Start transcription and allow microphone access.</li>
              <li>Stop and save when finished. The panel also stops when the CRM receives the call-ended event. Automatic summaries use the saved words afterward.</li>
            </ol>
            <p>The CRM creates short-lived session tokens automatically. Keep the permanent key here; never paste it into chat or browser code. Live transcription hears only the selected microphone, so phone audio must be audible to it.</p>
          </details>
          <div className="tiny muted">Patient data: live audio and summary text go to Google. Recording fallback uploads are deleted after analysis. Use a key from a paid (billing-enabled) Google Cloud project: Google does not use paid-tier API data to improve its models, while free-tier keys allow that and must not be used for patient calls.</div>
        </div>
      )}
    </Panel>
  );
}

function TelephonyTab() {
  const { profile } = useAuth();
  const isAdmin = roleAllows(['admin', 'supervisor'], profile?.role);   // supervisors run the call centre: they connect MyOperator too
  const h = useLoad(() => integrations(), []);
  const w = useLoad(() => webhookEvents(), []);
  const [openId, setOpenId] = useState(null);
  const st = (v) => (v === true ? <Badge kind="ok" dot>Connected</Badge> : typeof v === 'string' ? <Badge kind="info" dot>{v[0].toUpperCase() + v.slice(1)}</Badge> : <Badge kind="warn" dot>Not configured</Badge>);
  const items = [['supabase', 'Database & sign-in', 'Supabase Postgres + Auth'], ['telephony', 'Click-to-call', 'MyOperator OBD'], ['recordings', 'Recordings & call logs', 'MyOperator API'],
    ['whatsapp', 'WhatsApp', 'MyOperator WABA'], ['ai', 'AI assist', 'Gemini']];
  return (
    <div className="col gap-12">
      <Panel title="Integration status" actions={<Button size="sm" kind="ghost" icon="refresh" onClick={h.reload}>Recheck</Button>}>
        <ErrorNote error={h.error} />
        {h.loading ? <Skeleton lines={2} /> : (
          <div className="st-status">
            {items.map(([k, l, s]) => (
              <div key={k} className="st-cell"><div className="small strong">{l}</div><div className="tiny muted mb-8">{s}</div>
                {h.data?.demo && k === 'supabase' ? <Badge kind="info" dot>Demo database</Badge> : k === 'telephony' && h.data?.[k] === true ? <Badge kind="info" dot>Configured</Badge> : st(h.data?.[k])}</div>
            ))}
          </div>
        )}
        {h.data?.demo && <div className="tiny faint mt-12">Demo mode: telephony and AI are simulated in the browser.</div>}
      </Panel>

      {isAdmin && <AutodialPanel />}
      {isAdmin && <BmmIntegration />}
      {isAdmin ? <MyOperatorConnection /> : (
        <Panel title="MyOperator"><div className="small">The platform admin or a supervisor connects MyOperator and links agents here. The event log below shows every call event received.</div></Panel>
      )}
      {isAdmin && <AiSummaries onSaved={h.reload} />}
      <Panel title="Mailbox">
        <div className="small">In Cloudflare <strong>Email Routing</strong>, route the HHCS support address to the CareDesk Worker (action: Send to a Worker). Each e-mail becomes a ticket on the patient timeline, matched by the case number in the subject or the sender address, and starts the 5-minute acknowledgement SLA.</div>
      </Panel>

      <Panel tight title="Webhook event log" sub="Latest 50 events received from MyOperator" actions={<Button size="sm" kind="ghost" icon="refresh" onClick={w.reload}>Refresh</Button>}>
        <ErrorNote error={w.error} />
        {w.loading ? <TableSkeleton rows={6} cols={4} /> : w.data?.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Received</th><th>Event</th><th>Event id</th><th>Status</th><th /></tr></thead>
            <tbody>{w.data.map((e) => [
              <tr key={e.event_id} className="click" onClick={() => setOpenId(openId === e.event_id ? null : e.event_id)}>
                <td className="nowrap small mono">{dateTime(e.received_at)}</td>
                <td className="mono small">{e.event_type || '–'}</td>
                <td className="mono small truncate" style={{ maxWidth: 220 }}>{e.event_id}</td>
                <td>{e.error ? <Badge kind="danger" title={e.error}>Error</Badge> : e.processed ? <Badge kind="ok">Processed</Badge> : <Badge kind="warn">Queued</Badge>}</td>
                <td className="right"><Icon name={openId === e.event_id ? 'down' : 'chevron'} size={12} /></td>
              </tr>,
              openId === e.event_id && <tr key={e.event_id + '-raw'}><td colSpan={5} style={{ background: 'var(--panel-2)' }}>
                {e.error && <div className="small danger-text mb-8">{e.error}</div>}
                <pre className="st-pre">{JSON.stringify(e.payload, null, 2)}</pre></td></tr>,
            ])}</tbody>
          </table></div>
        ) : <Empty title="No webhook events yet">Events appear as soon as MyOperator posts the first call.</Empty>}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------ import from the old Hinduja CRM
function BmmIntegration() {
  const cfg = useLoad(() => rpc('bmm_settings', {}), [], ['bmm_integration_settings','profiles','providers']);
  const [f,setF] = useState(null);
  const [run,busy] = useAction();
  useEffect(() => { if (cfg.data && !f) setF({enabled:cfg.data.enabled,confirmed:cfg.data.contract_confirmed}); },[cfg.data,f]);
  const save = () => run(async () => {
    const saved = await rpc('set_bmm_integration',{p_enabled:f.enabled,p_contract_confirmed:f.confirmed});
    cfg.setData(saved);setF({enabled:saved.enabled,confirmed:saved.contract_confirmed});
  },'BMM integration settings saved');
  const d = cfg.data;
  return <Panel title="Book My Medicare integration" sub="BMM can retrieve its assigned leads and send progress updates using a dedicated provider login. Confirm their system supports this connection before activation.">
    <ErrorNote error={cfg.error} />
    {cfg.loading || (!f && !cfg.error) ? <Skeleton lines={3} /> : f && d && <div className="col gap-12">
      <div className="row gap-8"><Badge kind={d.enabled ? 'ok' : 'outline'}>{d.enabled ? 'Enabled' : 'Disabled'}</Badge><span className="small">{d.provider_logins} active BMM provider login{d.provider_logins === 1 ? '' : 's'}</span></div>
      {!d.provider_active && <div className="small warn-text">Book My Medicare must be active before enabling this connection.</div>}
      {!d.provider_logins && <div className="small warn-text">An administrator must create a provider login assigned to Book My Medicare under Settings, Users.</div>}
      <Check label="BMM has confirmed the connection format" checked={f.confirmed} onChange={e => setF({...f,confirmed:e.target.checked,enabled:e.target.checked && f.enabled})} />
      <Check label="Enable BMM system access" checked={f.enabled} disabled={!f.confirmed || !d.provider_logins || !d.provider_active} onChange={e => setF({...f,enabled:e.target.checked})} />
      <div><Button kind="primary" disabled={busy} onClick={save}>Save BMM settings</Button></div>
      <div className="small">Only service lines that are BMM's are shared: the provider chosen on the case line, otherwise the BMM service categories, in the unit agreed on the booking. Post-discharge patient details stay on hold until family sign-off. Calls, recordings, clinical validation and buying prices are excluded.</div>
      <dl className="kv"><dt>Retrieve leads</dt><dd className="mono small">GET /api/v1/bmm/leads</dd><dt>Update progress</dt><dd className="mono small">POST /api/v1/bmm/leads/&#123;id&#125;/status</dd></dl>
      <div className="tiny muted">Existing Provider leads and Excel status sync remain available while this connection is disabled.</div>
    </div>}
  </Panel>;
}

// Excel / CSV from the previous CRM -> patients and cases. Column names are matched loosely (e.g. "Phone",
// "Contact No" -> mobile). Each row gets a new CareDesk Case ID; the old ID is kept, so importing the same file
// again skips rows already in. Done in steps of 200 rows; errors are listed by row number.
const IMPORT_FIELDS = [
  ['ref', 'Old case / lead ID', ['ref', 'oldid', 'caseid', 'leadid', 'enquiryid', 'ticketid', 'id', 'srno', 'caseno', 'leadno']],
  ['patient_name', 'Patient name', ['patientname', 'patient', 'name', 'customername', 'clientname', 'fullname']],
  ['mobile', 'Mobile', ['mobile', 'mobileno', 'mobilenumber', 'phone', 'phoneno', 'phonenumber', 'contact', 'contactno', 'contactnumber']],
  ['alt_mobile', 'Alternate mobile', ['alternatemobile', 'altmobile', 'alternatenumber', 'alternatephone', 'mobile2', 'phone2']],
  ['email', 'Email', ['email', 'emailid', 'mail']],
  ['age', 'Age', ['age']],
  ['gender', 'Gender', ['gender', 'sex']],
  ['address', 'Address', ['address', 'patientaddress', 'fulladdress']],
  ['locality', 'Locality', ['locality', 'area', 'location']],
  ['pincode', 'Pincode', ['pincode', 'pin', 'zip', 'postalcode']],
  ['branch', 'Branch', ['branch', 'hospital', 'hospitalbranch', 'centre', 'center']],
  ['services', 'Services', ['services', 'service', 'servicerequired', 'servicetype', 'requirementtype', 'test', 'tests', 'category']],
  ['requirements', 'Requirements', ['requirements', 'requirement', 'remarks', 'additionalinfo', 'additionalinformation', 'description', 'details']],
  ['notes', 'Notes / history', ['notes', 'note', 'comments', 'comment', 'progress', 'progressnotes', 'history', 'followup']],
  ['status', 'Status', ['status', 'stage', 'leadstatus', 'casestatus']],
  ['date', 'Date', ['date', 'createdon', 'createdat', 'created', 'enquirydate', 'leaddate', 'registrationdate']],
];
const normHead = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const cellText = (v) => (v == null ? '' : v instanceof Date ? v.toISOString() : String(v).trim());

function ImportTab() {
  const [file, setFile] = useState(null);       // { name, rows, map, unmapped }
  const [res, setRes] = useState(null);         // { imported, skipped, errors, done, total }
  const [run, busy] = useAction();
  const template = () => {
    const ws = XLSX.utils.json_to_sheet([
      { 'Old ID': 'HHC-OLD-1001', 'Patient name': 'Asha Mehta', Mobile: '9820012345', Age: 78, Gender: 'F', Address: '12 Carter Road, Bandra West', Pincode: '400050',
        Branch: 'Khar', Services: 'Nursing care, physiotherapy', Requirements: 'Female nurse, 12-hour day shift', Notes: 'Started 1 Aug; family prefers WhatsApp', Status: 'Open', Date: '2026-08-01' },
      { 'Old ID': 'HHC-OLD-1002', 'Patient name': 'Ravi Kulkarni', Mobile: '9820054321', Age: 64, Gender: 'M', Address: 'Mahim Causeway', Pincode: '400016',
        Branch: 'Mahim', Services: 'ECG at home', Requirements: '', Notes: 'Report shared', Status: 'Completed', Date: '2026-07-20' },
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cases');
    XLSX.writeFile(wb, 'CareDesk-import-template.xlsx');
  };
  const read = async (f) => {
    setRes(null);
    if (!f) return;
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const raw = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
    const heads = raw.length ? Object.keys(raw[0]) : [];
    const map = {};
    for (const [key, , aliases] of IMPORT_FIELDS) {
      const h = heads.find((x) => aliases.includes(normHead(x))) || heads.find((x) => aliases.some((a) => a.length > 3 && normHead(x).includes(a)));
      if (h && !Object.values(map).includes(h)) map[key] = h;
    }
    const rows = raw.map((r) => Object.fromEntries(Object.entries(map).map(([k, h]) => [k, cellText(r[h])])))
      .filter((r) => Object.values(r).some(Boolean));
    setFile({ name: f.name, rows, map, unmapped: heads.filter((h) => !Object.values(map).includes(h)) });
  };
  const go = () => run(async () => {
    const total = file.rows.length;
    const acc = { imported: 0, skipped: 0, errors: [], done: 0, total };
    setRes({ ...acc });
    for (let i = 0; i < total; i += 200) {
      const chunk = file.rows.slice(i, i + 200);
      const r = await rpc('import_cases', { p_rows: chunk });
      acc.imported += r.imported; acc.skipped += r.skipped;
      acc.errors.push(...(r.errors || []).map((e) => ({ ...e, row: e.row + i + 1 })));   // +1: header row in the file
      acc.done = Math.min(total, i + chunk.length);
      setRes({ ...acc });
    }
  }, 'Import finished');
  const missing = file ? ['patient_name'].filter((k) => !file.map[k]).concat(!file.map.mobile && !file.map.ref ? ['mobile or old ID'] : []) : [];
  return (
    <div className="col gap-12">
      <Panel title="Import from the previous Hinduja CRM" sub="Excel or CSV export of patients and cases. Each row becomes a case with a new CareDesk Case ID; the old ID is kept on the case.">
        <ol className="st-steps small">
          <li>Export the old CRM's cases to Excel or CSV, one row per case. Column names do not have to match exactly. <Button size="xs" kind="ghost" icon="download" onClick={template}>Download template</Button></li>
          <li>Choose the file. CareDesk shows which columns it recognised and a preview.</li>
          <li>Import. Rows with a mobile number join the existing patient; services (nursing, ECG, ...) send each case to its provider; closed and cancelled cases keep their status. Importing the same file again skips rows already in.</li>
        </ol>
        <div className="row mt-12" style={{ gap: 8 }}>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => read(e.target.files?.[0]).catch((err) => setFile({ error: err.message }))} />
        </div>
        {file?.error && <ErrorNote error={`Could not read the file: ${file.error}`} />}
      </Panel>
      {file?.rows && (
        <Panel tight title={`${file.name} · ${file.rows.length.toLocaleString('en-IN')} rows`}
          actions={<Button kind="primary" disabled={busy || !file.rows.length || missing.length > 0 || (res && res.done === res.total)} onClick={go}>{busy ? 'Importing' : `Import ${file.rows.length.toLocaleString('en-IN')} rows`}</Button>}>
          <div className="panel-body">
            <div className="row wrap" style={{ gap: 6 }}>
              {IMPORT_FIELDS.map(([k, label]) => file.map[k]
                ? <Badge key={k} kind="ok" title={`from column "${file.map[k]}"`}>{label} ← {file.map[k]}</Badge>
                : <Badge key={k} kind={k === 'patient_name' ? 'danger' : ''}>{label}: not found</Badge>)}
            </div>
            {file.unmapped.length > 0 && <div className="tiny muted mt-8">Not imported (no matching field): {file.unmapped.join(', ')}. Rename a column to one of the names above to include it.</div>}
            {missing.length > 0 && <div className="small danger-text mt-8">Needed before importing: {missing.join(', ')}.</div>}
          </div>
          <div className="table-wrap"><table className="t compact">
            <thead><tr><th>#</th>{IMPORT_FIELDS.filter(([k]) => file.map[k]).map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
            <tbody>{file.rows.slice(0, 8).map((r, i) => (
              <tr key={i}><td className="mono tiny">{i + 2}</td>{IMPORT_FIELDS.filter(([k]) => file.map[k]).map(([k]) => <td key={k} className="small truncate" style={{ maxWidth: 180 }}>{r[k] || <span className="faint">–</span>}</td>)}</tr>
            ))}</tbody>
          </table></div>
          {file.rows.length > 8 && <div className="tiny faint panel-body">First 8 of {file.rows.length} rows shown.</div>}
        </Panel>
      )}
      {res && (
        <Panel title="Result" sub={res.done < res.total ? `Importing ${res.done} of ${res.total}...` : `Done: ${res.total} rows read`}>
          <div className="kpis">
            <Kpi label="Imported" value={res.imported} tone="ok" />
            <Kpi label="Already in (skipped)" value={res.skipped} />
            <Kpi label="Rows with errors" value={res.errors.length} tone={res.errors.length ? 'warn' : ''} />
          </div>
          {res.errors.length > 0 && (
            <table className="t compact mt-12"><thead><tr><th>File row</th><th>Old ID</th><th>Problem</th></tr></thead>
              <tbody>{res.errors.slice(0, 200).map((e) => <tr key={e.row}><td className="mono">{e.row}</td><td className="mono small">{e.ref || '–'}</td><td className="small">{e.message}</td></tr>)}</tbody></table>
          )}
        </Panel>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ data & exit
const EXPORTS = [
  ['Cases', 'v_cases', 'created_at'], ['Patients', 'v_patients', 'created_at'], ['Interactions', 'interactions', 'occurred_at'], ['Calls', 'v_calls', 'started_at'],
  ['Payments', 'payments', 'collected_at'], ['Complaints', 'complaints', 'opened_at'], ['Escalations', 'escalations', 'raised_at'], ['Approvals', 'approvals', 'requested_at'],
  ['Audit', 'v_audit', 'at'], ['Access', 'v_access', 'at'], ['QA reviews', 'qa_reviews', 'created_at'], ['Samples', 'samples', 'collected_at'], ['Assignments', 'v_assignments', 'assigned_at'],
];
const cell = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v);

function DataTab() {
  const { workspace } = useAuth();
  const [prog, setProg] = useState(null); // {Cases: n | 'loading' | 'error: ...'}
  const [run, busy] = useAction();
  const exportAll = () => run(async () => {
    const wb = XLSX.utils.book_new();
    const counts = {};
    setProg({});
    for (const [name, table, order] of EXPORTS) {
      setProg((p) => ({ ...p, [name]: 'loading' }));
      try {
        const rows = await q(db.from(table).select('*').order(order, { ascending: true, nullsFirst: true }).range(0, 9999));
        counts[name] = rows.length;
        const ws = XLSX.utils.json_to_sheet(rows.length ? rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, cell(v)]))) : [{ note: 'No rows visible to this role' }]);
        XLSX.utils.book_append_sheet(wb, ws, name);
        setProg((p) => ({ ...p, [name]: rows.length }));
      } catch (e) {
        counts[name] = `error: ${e.message}`;
        setProg((p) => ({ ...p, [name]: `error: ${e.message}` }));
      }
    }
    const stamp = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    XLSX.writeFile(wb, `${workspace?.code || 'HHC'}-CareDesk-full-export-${stamp}.xlsx`);
    await rpc('log_access', { p_action: 'export', p_entity: 'workspace', p_entity_id: workspace?.code || null, p_meta: { scope: 'full', format: 'xlsx', counts } });
  }, 'Full export downloaded · logged in the audit trail');
  return (
    <div className="grid g2">
      <Panel title="Export everything" sub="One Excel workbook, one sheet per table, up to 10,000 rows each">
        <div className="small">Includes cases, patients, the full interaction timeline, calls with AI summaries, payments, complaints, escalations, approvals, the audit and access logs, QA reviews, samples and field assignments.</div>
        <div className="row mt-12"><Button kind="primary" icon="download" onClick={exportAll} disabled={busy}>{busy ? 'Exporting' : 'Export everything'}</Button></div>
        {prog && <table className="t compact mt-12"><tbody>{EXPORTS.map(([name]) => {
          const v = prog[name];
          return <tr key={name}><td>{name}</td><td className="right">{v === undefined ? <span className="faint small">waiting</span> : v === 'loading' ? <span className="sk" style={{ display: 'inline-block', width: 40, height: 10 }} />
            : typeof v === 'number' ? <span className="mono">{v.toLocaleString('en-IN')} rows{v >= 10000 ? ' · capped' : ''}</span> : <span className="danger-text small">{v}</span>}</td></tr>;
        })}</tbody></table>}
        <div className="tiny faint mt-12">Call recordings are exported separately as audio files from MyOperator; lab reports as PDF from the lab system. This export is written to the access log.</div>
      </Panel>
      <Panel title="Exit plan" sub="Slide 21 · what happens if the engagement ends">
        <ol className="st-steps small">
          <li><strong>Notice and plan.</strong> Written notice per the contract, then a joint exit plan with owners and dates.</li>
          <li><strong>Inventory.</strong> List of every data set, recording store, template, number and mailbox held for HHCS.</li>
          <li><strong>Export.</strong> CRM data in Excel/CSV (this button), recordings in standard audio, reports in PDF, configuration (rate card, templates, SLAs) included.</li>
          <li><strong>Verification.</strong> Hinduja checks row counts and samples against the live system before sign-off.</li>
          <li><strong>Channel continuity.</strong> The DID number, support mailbox and WhatsApp Business ID transfer to Hinduja or its new operator, so patients see no break.</li>
          <li><strong>Certified deletion.</strong> SecondMedic deletes its copies, including backups, and issues a written deletion certificate, except where law requires retention.</li>
        </ol>
      </Panel>
    </div>
  );
}
