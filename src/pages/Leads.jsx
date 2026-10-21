// Provider leads: cases sent to SecondMedic or Book My Medicare by service (lead assignment and transfer).
// Book My Medicare staff land here and see only their own leads (row-level security); supervisors, coordinators,
// agents and Hinduja management use it to track every transfer. Recordings are never shown here.
import ProviderProgress from '../components/ProviderProgress.jsx';
import { useState } from 'react';
import * as XLSX from 'xlsx';
import { useNavigate } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { roleAllows, useAuth } from '../lib/auth.jsx';
import { num, ago, date, dateTime, dayLong } from '../lib/fmt.js';
import { PageHead, Panel, Kpi, Tabs, Button, Badge, Modal, Field, Input, Textarea, Select, TableSkeleton, Empty, ErrorNote, useAction, useToast } from '../components/ui.jsx';

export const REF_STATUS = {
  new: ['New', 'warn'], accepted: ['Accepted', 'info'], scheduled: ['Scheduled', 'accent'], dispatched: ['Dispatched', 'accent'], in_progress: ['Deployed', 'plum'],
  completed: ['Completed', 'ok'], declined: ['Declined', 'danger'], cancelled: ['Cancelled', ''],
};
export const RefBadge = ({ status }) => { const [l, k] = REF_STATUS[status] || [status, '']; return <Badge kind={k}>{l}</Badge>; };
const OPEN = ['new', 'accepted', 'scheduled', 'dispatched', 'in_progress'];
const COLS = 'id,case_id,case_no,provider_id,provider_code,provider_name,status,categories,branch,priority,patient_id,patient_name,patient_age,patient_gender,'
  + 'patient_mobile,caller_name,caller_relation,address,landmark,locality,pincode,services_requested,additional_info,clinical_notes,service_names,'
  + 'preferred_slot,scheduled_at,accepted_at,completed_at,decline_reason,last_note,assigned_name,created_at,case_created_at,fulfilment_managed,'
  + 'care_type,hospital_name,hospital_ward,expected_discharge_on,plan_days,dispatched_at,started_at,requested_service_start_on';

// The next steps a lead can take, for whoever may move it.
const NEXT = {
  new: [['accepted', 'Accept', 'primary'], ['declined', 'Decline']],
  accepted: [['scheduled', 'Schedule visit', 'primary'], ['declined', 'Decline']],
  scheduled: [['dispatched', 'Mark dispatched', 'primary'], ['in_progress', 'Mark deployed'], ['scheduled', 'Reschedule']],
  dispatched: [['in_progress', 'Mark deployed', 'primary']],
  in_progress: [['completed', 'Mark completed', 'primary']],
};

/** Who may move this lead: its own provider's staff, supervisors and Hinduja management. SecondMedic's own leads are not moved
 *  by hand: they follow the case stages (booking = accepted, deployment = scheduled ... closure = completed). */
export function canMove(profile, lead) {
  if (!profile || !lead || lead.provider_code === 'SM') return false;
  if (profile.role === 'provider') return profile.provider_id === lead.provider_id;
  return roleAllows(['supervisor', 'client_manager'], profile.role);
}

/** Buttons for one lead (also used on the case page). */
export function LeadActions({ lead, onDone, size = 'xs' }) {
  const { profile } = useAuth();
  const [dlg, setDlg] = useState(null);
  if (!canMove(profile, lead)) return lead?.provider_code === 'SM' && OPEN.includes(lead.status) ? <span className="tiny faint">Follows case stages</span> : null;
  const steps = lead.fulfilment_managed ? [] : NEXT[lead.status] || [];
  if (!steps.length && !roleAllows(['supervisor', 'client_manager'], profile.role)) return null;
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, flexWrap: 'nowrap' }}>
        {steps.map(([to, label, kind]) => <Button key={to + label} size={size} kind={kind} onClick={() => setDlg(to)}>{label}</Button>)}
        {['completed', 'declined', 'cancelled'].includes(lead.status) && roleAllows(['supervisor', 'client_manager'], profile.role) &&
          <Button size={size} onClick={() => setDlg('new')}>Reopen</Button>}
        {OPEN.includes(lead.status) && roleAllows(['supervisor', 'client_manager'], profile.role) && lead.provider_code !== 'SM' &&
          <Button size={size} kind="ghost" onClick={() => setDlg('cancelled')}>Cancel</Button>}
      </div>
      {dlg && <LeadStep lead={lead} to={dlg} onClose={() => setDlg(null)} onDone={() => { setDlg(null); onDone?.(); }} />}
    </>
  );
}

const STEP_TITLE = { accepted: 'Accept lead', scheduled: 'Schedule the visit', dispatched: 'Staff or equipment dispatched', in_progress: 'Deployed, service started', completed: 'Mark service completed',
  declined: 'Decline lead', cancelled: 'Cancel lead', new: 'Reopen lead' };

function LeadStep({ lead, to, onClose, onDone }) {
  const [note, setNote] = useState('');
  const [when, setWhen] = useState(() => {
    const d = lead.scheduled_at || lead.preferred_slot;
    if (!d) return '';
    const t = new Date(new Date(d).getTime() + 5.5 * 3600e3);
    return t.toISOString().slice(0, 16);
  });
  const [run, busy] = useAction();
  const needWhen = to === 'scheduled';
  const needNote = to === 'declined' || to === 'cancelled';
  const ok = (!needWhen || when) && (!needNote || note.trim());
  const save = () => run(async () => {
    const iso = when ? new Date(when + ':00+05:30').toISOString() : null;
    if (to === 'accepted' && lead.provider_code !== 'SM') await rpc('accept_provider_lead', { p_id: lead.id, p_note: note.trim() || null });
    else await rpc('update_referral', { p_id: lead.id, p_status: to, p_note: note.trim() || null, p_when: needWhen ? iso : null });
    onDone();
  }, STEP_TITLE[to] + ': saved');
  return (
    <Modal title={`${STEP_TITLE[to]} · ${lead.case_no}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind={to === 'declined' || to === 'cancelled' ? 'danger' : 'primary'} disabled={!ok || busy} onClick={save}>Save</Button></>}>
      <div className="small muted mb-8">{lead.patient_name} · {lead.service_names || lead.services_requested || 'Services not listed'}</div>
      {needWhen && <Field label="Visit date and time (IST)"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>}
      <Field label={needNote ? 'Reason' : 'Progress note (optional)'} hint={needNote ? 'shown to the call centre and supervisor' : 'goes on the patient timeline'} className="mt-12">
        <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} autoFocus={!needWhen} />
      </Field>
    </Modal>
  );
}

/** embedded: inside the BMM workspace (no page head); providerId: only that provider's leads, no provider filter. */
export default function Leads({ embedded = false, providerId = null } = {}) {
  const nav = useNavigate();
  const now = useNow(30000);
  const { profile } = useAuth();
  const isProvider = profile?.role === 'provider';
  const [tab, setTab] = useState('open');
  const [provider, setProvider] = useState(providerId || '');
  const [branch, setBranch] = useState('');
  const [open, setOpen] = useState(null);

  const { data, loading, error, reload } = useLoad(async () => {
    const [rows, providers] = await Promise.all([
      q(db.from('v_referrals').select(COLS).order('created_at', { ascending: false }).limit(500)),
      q(db.from('providers').select('id,code,name').order('code', { ascending: false })),
    ]);
    return { rows, providers };
  }, [], ['case_referrals', 'cases']);

  const all = (data?.rows || []).filter((r) => r.status !== 'cancelled' || tab === 'closed')
    .filter((r) => !provider || r.provider_id === provider).filter((r) => !branch || r.branch === branch);
  const byTab = {
    open: all.filter((r) => OPEN.includes(r.status)),
    new: all.filter((r) => r.status === 'new'),
    completed: all.filter((r) => r.status === 'completed'),
    closed: all.filter((r) => ['declined', 'cancelled'].includes(r.status)),
  };
  const rows = byTab[tab];
  const waiting = byTab.new.length;
  const oldestNew = byTab.new.reduce((m, r) => Math.min(m, new Date(r.created_at).getTime()), Infinity);
  const doneWeek = all.filter((r) => r.status === 'completed' && r.completed_at && now - new Date(r.completed_at) < 7 * 86400e3).length;
  const branches = [...new Set((data?.rows || []).map((r) => r.branch).filter(Boolean))].sort();
  const providerName = isProvider ? data?.providers?.find((p) => p.id === profile.provider_id)?.name : null;

  return (
    <>
      {!embedded && <PageHead title={providerName ? `${providerName} · leads` : 'Provider leads'}
        sub={isProvider ? 'Cases sent to you by the Hinduja call centre: case ID, patient details and requirements. Accept, schedule, add progress notes and complete.'
          : 'Every case is sent to SecondMedic (ECG, X-ray, blood tests) or Book My Medicare (nursing, physiotherapy, beds, elder care) by its services.'} />}
      <ErrorNote error={error} />
      {(isProvider || roleAllows(['supervisor', 'client_manager'], profile?.role)) && <SheetSync rows={(data?.rows || []).filter((r) => OPEN.includes(r.status))} onDone={reload} isProvider={isProvider} />}
      <div className="kpis mb-16">
        <Kpi label="New, waiting to be accepted" value={data && num(waiting)} detail={waiting ? `oldest ${ago(new Date(oldestNew), now)}` : 'none waiting'} tone={waiting ? 'warn' : 'ok'} onClick={() => setTab('new')} />
        <Kpi label="Open leads" value={data && num(byTab.open.length)} detail="accepted, scheduled, dispatched or deployed" onClick={() => setTab('open')} />
        <Kpi label="Completed in 7 days" value={data && num(doneWeek)} tone="ok" onClick={() => setTab('completed')} />
        <Kpi label="Declined or cancelled" value={data && num(byTab.closed.length)} detail="sent back to the call centre" tone={byTab.closed.length ? 'warn' : ''} onClick={() => setTab('closed')} />
      </div>
      <Panel tight>
        <div className="panel-body row wrap" style={{ paddingBottom: 0, justifyContent: 'space-between', gap: 12 }}>
          <Tabs value={tab} onChange={setTab} tabs={[['open', 'Open', byTab.open.length], ['new', 'New', byTab.new.length], ['completed', 'Completed', byTab.completed.length], ['closed', 'Declined / cancelled', byTab.closed.length]]} />
          <div className="row" style={{ gap: 8 }}>
            {!isProvider && !providerId && <Select value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="All providers" options={(data?.providers || []).map((p) => [p.id, p.name])} />}
            {branches.length > 0 && <Select value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="All branches" options={branches} />}
          </div>
        </div>
        {loading ? <TableSkeleton rows={6} cols={7} /> : !rows?.length ? (
          <Empty title={tab === 'new' ? 'No new leads' : 'No leads here'}>{isProvider ? 'New leads appear here the moment the call centre registers a case for your services.' : null}</Empty>
        ) : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Case</th><th>Patient</th><th>Services and requirements</th>{!isProvider && !providerId && <th>Provider</th>}<th>Branch</th><th>Status</th><th>Received</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="click" onClick={() => setOpen(r)}>
                <td className="mono small nowrap">{r.case_no}{r.priority === 'urgent' && <div><Badge kind="danger">Urgent</Badge></div>}</td>
                <td style={{ maxWidth: 200 }}><div className="small strong truncate">{r.patient_name}</div>
                  <div className="tiny muted">{[r.patient_age, r.patient_gender].filter(Boolean).join('')}{r.patient_mobile ? ` · ${r.patient_mobile}` : ''}</div></td>
                <td style={{ maxWidth: 300 }}><div className="small truncate">{r.service_names || r.services_requested || '–'}</div>
                  {r.care_type === 'post_discharge' && <div className="tiny warn-text">Post-discharge{r.expected_discharge_on ? ` · discharge ${date(r.expected_discharge_on)}` : ''}{r.plan_days ? ` · ${r.plan_days} days` : ''}</div>}
                  {r.additional_info && <div className="tiny muted truncate" title={r.additional_info}>{r.additional_info}</div>}</td>
                {!isProvider && !providerId && <td className="small nowrap">{r.provider_name}</td>}
                <td className="small">{r.branch || <span className="faint">–</span>}</td>
                <td className="nowrap"><RefBadge status={r.status} />{r.status === 'scheduled' && r.scheduled_at && <div className="tiny muted">{dateTime(r.scheduled_at)}</div>}</td>
                <td className="small nowrap" title={dateTime(r.created_at)}>{ago(r.created_at, now)}</td>
                <td className="right nowrap" onClick={(e) => e.stopPropagation()}><LeadActions lead={r} onDone={reload} /></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>
      {open && <LeadDrawer lead={(data?.rows || []).find((x) => x.id === open.id) || open} onClose={() => setOpen(null)} onOpenCase={() => nav(`/cases/${open.case_id}`)} reload={reload} />}
    </>
  );
}

function LeadDrawer({ lead: r, onClose, onOpenCase, reload }) {
  const { profile } = useAuth();
  const [note, setNote] = useState('');
  const [run, busy] = useAction();
  const tl = useLoad(() => q(db.from('interactions').select('id,channel,summary,body,actor_label,occurred_at').eq('case_id', r.case_id).order('occurred_at', { ascending: false }).limit(50)), [r.case_id], ['interactions']);
  const addNote = () => run(async () => {
    await q(db.from('interactions').insert({ workspace_id: profile.workspace_id, case_id: r.case_id, patient_id: r.patient_id, channel: 'note', direction: 'internal',
      actor_id: profile.id, actor_label: profile.agent_code || profile.full_name, summary: 'Progress note', body: note.trim() }));
    setNote(''); tl.reload();
  }, 'Progress note added');
  const dl = (k, v) => v ? <><dt>{k}</dt><dd className="small">{v}</dd></> : null;
  return (
    <Modal wide title={`${r.case_no} · ${r.patient_name}`} onClose={onClose}
      footer={<><Button onClick={onOpenCase}>Open full case</Button><div className="grow" /><LeadActions lead={r} onDone={reload} size="sm" /></>}>
      <div className="grid g2" style={{ gap: 16 }}>
        <div>
          <div className="row mb-8" style={{ gap: 8 }}><RefBadge status={r.status} /><span className="small muted">{r.provider_name}{r.assigned_name ? ` · ${r.assigned_name}` : ''}</span></div>
          <dl className="kv">
            {dl('Patient', [r.patient_name, [r.patient_age, r.patient_gender].filter(Boolean).join('')].filter(Boolean).join(' · '))}
            {dl('Mobile', r.patient_mobile)}
            {dl('Caller', [r.caller_name, r.caller_relation].filter(Boolean).join(' · '))}
            {dl('Address', [r.address, r.landmark, r.locality, r.pincode].filter(Boolean).join(', '))}
            {dl('Branch', r.branch)}
            {dl('Hospital', r.care_type === 'post_discharge' && [r.hospital_name, r.hospital_ward].filter(Boolean).join(', '))}
            {dl('Discharge', r.expected_discharge_on && `${date(r.expected_discharge_on)}${r.plan_days ? ` · ${r.plan_days}-day plan` : ''}`)}
            {dl('Service start requested', r.requested_service_start_on && dayLong(r.requested_service_start_on))}
            {dl('Services', r.service_names || r.services_requested)}
            {dl('Requirements', r.additional_info)}
            {dl('Clinical notes', r.clinical_notes)}
            {dl('Preferred slot', r.preferred_slot && dateTime(r.preferred_slot))}
            {dl('Visit', r.scheduled_at && dateTime(r.scheduled_at))}
            {dl('Dispatched', r.dispatched_at && dateTime(r.dispatched_at))}
            {dl('Deployed', r.started_at && dateTime(r.started_at))}
            {dl('Declined because', r.decline_reason)}
          </dl>
          <div className="tiny faint mt-8">Call recordings are not shared with service providers.</div>
          {r.provider_code !== 'SM' && <><ProviderProgress referralId={r.id} /><WorkOrders lead={r} /></>}
        </div>
        <div className="col gap-12">
          <div className="section-title">Progress notes and history</div>
          <div className="row" style={{ gap: 6 }}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a progress note" className="grow" onKeyDown={(e) => { if (e.key === 'Enter' && note.trim()) addNote(); }} />
            <Button size="sm" disabled={!note.trim() || busy} onClick={addNote}>Add</Button>
          </div>
          {tl.loading ? <TableSkeleton rows={4} cols={1} /> : (
            <div className="tl">
              {(tl.data || []).map((i) => (
                <div key={i.id} className="tl-item" style={{ gridTemplateColumns: '92px 1fr' }}>
                  <div className="tl-time">{dateTime(i.occurred_at)}</div>
                  <div className="tl-body"><div className="s small">{i.summary}</div><div className="meta">{i.actor_label || 'System'}</div>
                    {i.body && <div className="b">{i.body}</div>}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

const SHEET_STATUS = { new: 'New', accepted: 'Accepted', scheduled: 'Scheduled', dispatched: 'Dispatched', in_progress: 'Deployed', completed: 'Completed', declined: 'Declined' };
const cellText = (v) => (v instanceof Date ? v.toISOString() : String(v ?? '').trim());

/** Temporary Excel sync for a partner: download open leads, update the Status and Note columns, upload. Each row goes
 *  through the same lead rules as the buttons (update_referral); unknown cases or refused steps come back row by row. */
function SheetSync({ rows, onDone, isProvider }) {
  const toast = useToast();
  const [res, setRes] = useState(null);
  const [run, busy] = useAction();
  const mine = rows.filter((r) => r.provider_code !== 'SM');
  const download = () => {
    const ws = XLSX.utils.json_to_sheet(mine.map((r) => ({
      'Case no': r.case_no, ...(isProvider ? {} : { Provider: r.provider_code }), Patient: r.patient_name, Services: r.service_names || r.services_requested || '',
      Hospital: [r.hospital_name, r.hospital_ward].filter(Boolean).join(', '), Discharge: r.expected_discharge_on || '',
      Status: SHEET_STATUS[r.status] || r.status, 'Visit (IST)': r.scheduled_at ? dateTime(r.scheduled_at) : '', Note: '' })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Leads');
    XLSX.writeFile(wb, `CareDesk-leads-${new Date().toISOString().slice(0, 10)}.xlsx`);
    rpc('log_access', { p_action: 'export', p_entity: 'case_referrals', p_entity_id: null, p_meta: { scope: 'partner_sheet', rows: mine.length } }).catch(() => {});
  };
  const upload = (f) => run(async () => {
    if (!f) return;
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true });
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: true });
    const pick = (r, ...keys) => { const k = Object.keys(r).find((h) => keys.includes(h.toLowerCase().replace(/[^a-z]/g, ''))); return k ? cellText(r[k]) : ''; };
    const out = raw.map((r) => ({ case_no: pick(r, 'caseno', 'case', 'caseid'), status: pick(r, 'status'), note: pick(r, 'note', 'notes', 'remarks') || null,
      provider: pick(r, 'provider') || null })).filter((r) => r.case_no);
    const r = await rpc('import_referral_updates', { p_rows: out });
    setRes(r);
    onDone?.();
    toast.ok(`Sheet applied: ${r.updated} updated, ${r.skipped} unchanged${r.errors?.length ? `, ${r.errors.length} not applied` : ''}`);
  });
  return (
    <Panel title="Excel status sync" sub="Until your team works on this page directly: download the open leads, set the Status column (Accepted, Dispatched, Deployed, Completed, Declined) and a note, then upload the file.">
      <div className="row wrap" style={{ gap: 8 }}>
        <Button size="sm" icon="download" onClick={download} disabled={!mine.length}>Download open leads</Button>
        <label className={`btn sm ${busy ? 'disabled' : ''}`}>Upload updated sheet<input type="file" accept=".xlsx,.xls,.csv" hidden disabled={busy} onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} /></label>
      </div>
      {res?.errors?.length > 0 && (
        <div className="mt-12 small">
          <div className="strong">Rows not applied</div>
          {res.errors.map((e) => <div key={e.row} className="danger-text">Row {e.row + 1}{e.case_no ? ` · ${e.case_no}` : ''}: {e.message}</div>)}
        </div>
      )}
    </Panel>
  );
}

const WO_STATUS = { dispatched: ['accent', 'Dispatched'], delivered: ['info', 'Delivered'], installed: ['plum', 'Installed'], active: ['ok', 'On duty / in use'],
  returned: ['', 'Returned'], cancelled: ['', 'Cancelled'] };
const WO_NEXT = { staff: { dispatched: ['active', 'Mark on duty'], active: ['returned', 'Relieved'] },
  equipment: { dispatched: ['delivered', 'Delivered'], delivered: ['installed', 'Installed'], installed: ['active', 'In use'], active: ['returned', 'Picked up'] } };

/** Book My Medicare work orders for one lead: each nurse / attendant (staff ID, shift) and each piece of equipment (model,
 *  serial), with dispatch, delivery, install and on-duty times. Logging the first one moves the lead to Dispatched,
 *  the first install / on-duty to Deployed. */
function WorkOrders({ lead }) {
  const { profile } = useAuth();
  const can = !lead.fulfilment_managed && canMove(profile, lead) && ['accepted', 'scheduled', 'dispatched', 'in_progress'].includes(lead.status);
  const wo = useLoad(() => q(db.from('v_deployments').select('*').eq('referral_id', lead.id).order('created_at')), [lead.id], ['partner_deployments']);
  const items = useLoad(() => q(db.from('case_items').select('id,service_name,category,qty,excluded').eq('case_id', lead.case_id).order('created_at')), [lead.case_id]);
  const mine = (items.data || []).filter((i) => !i.excluded && (!lead.categories?.length || lead.categories.includes(i.category)));
  const [form, setForm] = useState(null);
  const [step, setStep] = useState(null);
  const [run, busy] = useAction();
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = (p, msg) => run(async () => { await rpc('log_deployment', { p_referral: lead.id, p }); setForm(null); setStep(null); wo.reload(); }, msg);
  const ok = form && (form.resource_type === 'staff' ? form.staff_name?.trim() && form.staff_ref?.trim() : true);
  return (
    <div className="col gap-8 mt-16">
      <div className="section-title">Staff and equipment</div>
      {wo.loading ? <TableSkeleton rows={2} cols={3} /> : (wo.data || []).length ? (
        <table className="t compact"><tbody>{wo.data.map((d) => {
          const [k, l] = WO_STATUS[d.status] || ['', d.status];
          const nx = WO_NEXT[d.resource_type]?.[d.status];
          return (
            <tr key={d.id}>
              <td><div className="small strong">{d.resource_type === 'staff' ? `${d.staff_name} · ID ${d.staff_ref}` : `${d.equipment_model || d.service_name || 'Equipment'}`}</div>
                <div className="tiny muted">{d.service_name ? `${d.service_name} · ` : ''}{d.resource_type === 'staff' ? (d.shift ? `${d.shift} shift` : '') : (d.equipment_serial ? `Serial ${d.equipment_serial}` : 'Serial not logged')}</div>
                <div className="tiny faint">{[d.dispatched_at && `out ${dateTime(d.dispatched_at)}`, d.delivered_at && `delivered ${dateTime(d.delivered_at)}`,
                  d.installed_at && `installed ${dateTime(d.installed_at)}`, d.active_from && `from ${dateTime(d.active_from)}`].filter(Boolean).join(' · ')}</div></td>
              <td className="nowrap"><Badge kind={k}>{l}</Badge></td>
              {can && <td className="right nowrap">{nx && <Button size="xs" disabled={busy} onClick={() => (nx[0] === 'installed' && !d.equipment_serial ? setStep({ d, to: nx[0], serial: '' })
                : save({ id: d.id, status: nx[0] }, `${l} → ${WO_STATUS[nx[0]][1]}`))}>{nx[1]}</Button>}</td>}
            </tr>
          );
        })}</tbody></table>
      ) : <div className="small muted">Nothing dispatched yet.</div>}
      {step && (
        <div className="row gap-8">
          <Input className="grow" value={step.serial} onChange={(e) => setStep((x) => ({ ...x, serial: e.target.value }))} placeholder="Equipment serial number" aria-label="Equipment serial number" />
          <Button size="sm" kind="primary" disabled={busy || !step.serial.trim()} onClick={() => save({ id: step.d.id, status: step.to, equipment_serial: step.serial.trim() }, 'Installed · serial logged')}>Save</Button>
          <Button size="sm" onClick={() => setStep(null)}>Cancel</Button>
        </div>
      )}
      {can && !form && <div className="row gap-8">
        <Button size="sm" onClick={() => setForm({ resource_type: 'staff', case_item_id: '', staff_name: '', staff_ref: '', shift: 'day', note: '' })}>Dispatch staff</Button>
        <Button size="sm" onClick={() => setForm({ resource_type: 'equipment', case_item_id: '', equipment_model: '', equipment_serial: '', note: '' })}>Dispatch equipment</Button>
      </div>}
      {form && (
        <div className="col gap-8">
          <Field label="For item"><Select value={form.case_item_id} onChange={set('case_item_id')} placeholder="Choose" options={mine.map((i) => [i.id, `${i.service_name} × ${i.qty}`])} /></Field>
          {form.resource_type === 'staff' ? (
            <div className="grid g3" style={{ gap: 8 }}>
              <Field label="Name"><Input value={form.staff_name} onChange={set('staff_name')} /></Field>
              <Field label="Staff ID"><Input value={form.staff_ref} onChange={set('staff_ref')} placeholder="BMM-N-114" /></Field>
              <Field label="Shift"><Select value={form.shift} onChange={set('shift')} options={[['day', 'Day (12 h)'], ['night', 'Night (12 h)'], ['24h', '24 hours']]} /></Field>
            </div>
          ) : (
            <div className="grid g2" style={{ gap: 8 }}>
              <Field label="Model"><Input value={form.equipment_model} onChange={set('equipment_model')} placeholder="Airvo 2" /></Field>
              <Field label="Serial number" hint="needed at delivery"><Input value={form.equipment_serial} onChange={set('equipment_serial')} /></Field>
            </div>
          )}
          <Field label="Note (optional)"><Input value={form.note} onChange={set('note')} /></Field>
          <div className="row gap-8">
            <Button size="sm" kind="primary" disabled={!ok || busy} onClick={() => save({ ...form, case_item_id: form.case_item_id || null, status: 'dispatched' }, 'Dispatched · lead updated')}>Save as dispatched</Button>
            <Button size="sm" onClick={() => setForm(null)}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
