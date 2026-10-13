// 360-degree case view (proposal slide 8): stage gates, locked rate card and discount governance,
// booking, field dispatch, chain of custody, payments, unified timeline and audit, with an AI brief.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { dial, sendQuote, sendMessage, sendWhatsAppChat, aiBrief, recordingUrl } from '../lib/api.js';
import {
  inr, ago, time, date, dateTime, dur, STAGES, STAGE_LABEL, SLA_LABEL, CHANNEL_LABEL, toLocalInput, fromLocalInput,
} from '../lib/fmt.js';
import Icon, { channelIcon } from '../components/icons.jsx';
import { useCalls, LiveCallBar } from '../components/CallCenter.jsx';
import { LeadActions, RefBadge } from './Leads.jsx';
import { TransitionPanel } from './Transition.jsx';
import {
  Panel, Button, Badge, StageBadge, SlaBadge, PriorityBadge, Countdown, AiTag, Tabs, Modal, Field, Input, Select, Textarea,
  Segmented, Confirm, Empty, TableSkeleton, Skeleton, ErrorNote, useToast, useAction,
} from '../components/ui.jsx';

const LIVE = ['cases', 'interactions', 'case_items', 'assignments', 'samples', 'payments', 'approvals', 'escalations', 'complaints', 'calls', 'case_referrals', 'discharge_assessments'];
const DASH = '–';
const QUOTE_KIND = { draft: ['', 'Draft'], pending_approval: ['warn', 'Awaiting approval'], approved: ['ok', 'Approved'], rejected: ['danger', 'Rejected'], sent: ['accent', 'Sent'] };
const PAY_KIND = { unpaid: ['', 'Unpaid'], partial: ['warn', 'Part paid'], paid: ['accent', 'Paid, not reconciled'], reconciled: ['ok', 'Reconciled'], refund: ['danger', 'Refund'], waived: ['info', 'Waived'] };
const ASG_KIND = { assigned: 'info', en_route: 'warn', checked_in: 'accent', completed: 'ok', cancelled: '', reassigned: '' };
const ASG_LABEL = { assigned: 'Assigned', en_route: 'En route', checked_in: 'Checked in', completed: 'Completed', cancelled: 'Cancelled', reassigned: 'Reassigned' };
const TASK_LABEL = { phlebotomy: 'Phlebotomy', xray: 'Portable X-ray', ecg: 'ECG', visit: 'Visit' };
const CAT_TASK = { lab: 'phlebotomy', ecg: 'ecg', xray: 'xray' };
const CAT_LABEL = { lab: 'Sample collection', xray: 'Portable X-ray', ecg: 'ECG at home', visit: 'Visit charge', nursing: 'Nursing', physio: 'Physiotherapy', beds: 'Hospital beds', eldercare: 'Elder care', homecare: 'Home care', equipment: 'Equipment', icu: 'ICU setup', other: 'Other' };
const HOPS = [
  ['collected_at', 'Collected'], ['handover_at', 'Handover'], ['dispatched_at', 'Dispatched'], ['transport_temp_c', 'Temp'],
  ['received_at', 'Received at lab'], ['accessioned_at', 'Accessioned'], ['report_released_at', 'Report released'], ['delivered_at', 'Delivered'],
];
const ESC_TYPES = [['clinical', 'Clinical'], ['emergency', 'Emergency'], ['delay', 'Delay'], ['complaint', 'Complaint'], ['privacy', 'Privacy']];
const CMP_CATS = [['service', 'Service'], ['behaviour', 'Staff behaviour'], ['billing', 'Billing'], ['report_delay', 'Report delay'], ['other', 'Other']];

const parseJson = (v) => { if (!v) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };
const ageGender = (c) => [c.patient_age, c.patient_gender].filter((x) => x != null && x !== '').join(' ');
const stageIndex = (s) => STAGES.indexOf(s);
const nextSlot = () => { const d = new Date(Date.now() + 2 * 3600e3); d.setMinutes(0, 0, 0); return d.toISOString(); };
const agoC = (d, now) => ago(d, Math.max(now, d ? new Date(d).getTime() : 0));
const isOpenStage = (s) => !['closed', 'cancelled'].includes(s);

export default function CaseDetail() {
  const { id } = useParams();
  const toast = useToast();
  const { profile, workspace, can, isOps } = useAuth();
  const { active } = useCalls();
  const now = useNow(30000);
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null);
  const [menu, setMenu] = useState(false);

  useEffect(() => { rpc('log_access', { p_action: 'view_case', p_entity: 'case', p_entity_id: id, p_meta: {} }).catch(() => {}); }, [id]);

  const L = (fn) => useLoad(fn, [id], LIVE); // eslint-disable-line react-hooks/rules-of-hooks
  const cs = L(() => q(db.from('v_cases').select('*').eq('id', id).maybeSingle()));
  const hist = L(() => q(db.from('case_stage_history').select('id,from_stage,to_stage,changed_at,note').eq('case_id', id).order('changed_at')));
  const items = L(() => q(db.from('case_items').select('*').eq('case_id', id).order('created_at')));
  const asg = L(() => q(db.from('v_assignments').select('id,staff_id,staff_name,staff_phone,task,status,assigned_at,eta,checkin_at,checkin_distance_m,checkout_at,checklist,patient_signoff,backup_for,delay_reason').eq('case_id', id).order('assigned_at')));
  const samples = L(() => q(db.from('samples').select('*').eq('case_id', id).order('collected_at')));
  const pays = L(() => q(db.from('payments').select('*').eq('case_id', id).order('collected_at')));
  const appr = L(() => q(db.from('v_approvals').select('*').eq('case_id', id).order('requested_at', { ascending: false })));
  const timers = L(() => q(db.from('sla_timers').select('id,policy_key,started_at,due_at,met_at,breached_at,status,complaint_id').eq('case_id', id).order('due_at')));
  const inter = L(() => q(db.from('interactions').select('id,channel,direction,actor_label,summary,body,evidence,occurred_at,call_id,template_id').eq('case_id', id).order('occurred_at', { ascending: false }).limit(300)));
  const calls = L(() => q(db.from('v_calls').select('id,direction,status,started_at,ring_seconds,talk_seconds,agent_label,has_recording,ai_summary,ai_sentiment,ai_flags,disposition').eq('case_id', id).order('started_at', { ascending: false })));
  const escs = L(() => q(db.from('v_escalations').select('*').eq('case_id', id).order('raised_at', { ascending: false })));
  const cmps = L(() => q(db.from('v_complaints').select('*').eq('case_id', id).order('opened_at', { ascending: false })));
  const refs = L(() => q(db.from('v_referrals').select('id,case_id,case_no,provider_id,provider_code,provider_name,status,categories,service_names,services_requested,patient_name,scheduled_at,accepted_at,completed_at,decline_reason,last_note,assigned_name,preferred_slot,created_at').eq('case_id', id).order('created_at')));
  const services = useLoad(() => q(db.from('services').select('id,code,name,category,price,tat_hours,unit').is('active', true).order('category').order('price')), []);
  const templates = useLoad(() => q(db.from('templates').select('id,kind,code,title,body,status,version').eq('status', 'approved').order('code')), []);
  const people = useLoad(() => q(db.from('profiles').select('id,full_name,role,skills,on_duty,agent_code,zone_id').in('role', ['coordinator', 'field_staff']).is('active', true).order('full_name')), []);

  const c = cs.data;
  // case_gates is a read-only RPC: refresh it when the case or its dependents change (not via live events)
  const gateKey = c ? [c.stage, c.updated_at, c.quote_status, c.payment_status, c.report_status, c.feedback_rating, c.open_complaints,
    (items.data || []).length, (asg.data || []).map((a) => a.status + a.patient_signoff).join(), (samples.data || []).length,
    c.consent_verbal_at, c.consent_digital_at, c.booked_slot, c.coordinator_id, c.validation_status, c.signoff_at, c.intake_disposition,
    c.spoke_with, c.expected_discharge_on, c.care_type, (items.data || []).map((i) => i.excluded).join()].join('|') : '';
  const gates = useLoad(() => (c ? rpc('case_gates', { p_case: id }) : null), [gateKey]);

  if (cs.loading) return <DetailSkeleton />;
  if (cs.error) return <ErrorNote error={cs.error} />;
  if (!c) {
    return (
      <Panel><Empty title="Case not found">This case does not exist or is outside your queue. <Link to="/cases">Back to cases</Link></Empty></Panel>
    );
  }

  const canAct = isOps;                                   // agents, coordinators, supervisors, medical desk
  const canDispatch = can('coordinator', 'supervisor');
  const canReopen = can('coordinator', 'supervisor');
  const canDial = can('agent', 'coordinator', 'supervisor', 'medical_desk');
  const open = isOpenStage(c.stage);
  const hrows = hist.data || [];
  const cancelledFrom = c.stage === 'cancelled' ? [...hrows].reverse().find((h) => h.to_stage === 'cancelled')?.from_stage : null;
  const phase = c.stage === 'closed' ? STAGES.length : c.stage === 'cancelled' ? Math.max(0, stageIndex(cancelledFrom)) : stageIndex(c.stage);
  const onCall = active && active.case_id === id;
  const tpl = templates.data || [];
  const updateTemplates = tpl.filter((t) => t.kind !== 'script' && t.code !== 'T-03');
  const s09 = tpl.find((t) => t.code === 'S-09');
  const brief = parseJson(c.ai_brief);

  const insertEsc = (type, text) => q(db.from('escalations').insert({
    workspace_id: profile.workspace_id, case_id: id, type, level: 1, trigger_text: text, raised_by: profile.id,
  }));

  return (
    <div className="cd">
      <div className="row small muted mb-8"><Link to="/cases">Cases</Link><Icon name="chevron" size={12} /><span className="mono">{c.case_no}</span></div>

      {/* ---------- header */}
      <div className="cd-head panel">
        <div className="cd-id">
          <div className="row wrap gap-8">
            <h1 className="cd-no mono">{c.case_no}</h1>
            <StageBadge stage={c.stage} />
            {open && <SlaBadge state={c.sla_state} />}
            <PriorityBadge p={c.priority} />
            {c.next_sla_due && <Countdown due={c.next_sla_due} label={c.next_sla_key} />}
            {Number(c.open_escalations) > 0 && <Badge kind="danger" dot>{c.open_escalations} open escalation{c.open_escalations > 1 ? 's' : ''}</Badge>}
          </div>
          <div className="cd-meta">
            <span><strong>{c.patient_name}</strong>{ageGender(c) && <span className="muted"> · {ageGender(c)}</span>}</span>
            {c.branch && <span><span className="muted">Branch</span> {c.branch}</span>}
            <span className="muted">{c.zone_name || 'Zone not mapped'}</span>
            <span><span className="muted">Owner</span> {c.owner_name || DASH}{c.owner_code ? <span className="mono muted"> {c.owner_code}</span> : null}</span>
            <span><span className="muted">Coordinator</span> {c.coordinator_name || DASH}</span>
            <span className="muted" title={dateTime(c.created_at)}>Created {dateTime(c.created_at)} · {ago(c.created_at, now)} · via {CHANNEL_LABEL[c.source_channel] || c.source_channel}</span>
          </div>
        </div>
        <div className="row wrap cd-actions">
          {canDial && open && <Button kind="call" icon="phone" disabled={busy || onCall} onClick={() => run(async () => { await dial({ case_id: id }); toast.ok('Dialling through MyOperator · your phone rings first'); })}>Call patient</Button>}
          {!can('provider') && <Link to={`/whatsapp?patient=${c.patient_id}`} className="btn"><Icon name="chat" />WhatsApp chat</Link>}
          {canAct && open && updateTemplates.length > 0 && (
            <div className="cd-menu-wrap">
              <Button icon="chat" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>Send update<Icon name="down" size={12} /></Button>
              {menu && (
                <>
                  <div className="cd-menu-scrim" onClick={() => setMenu(false)} />
                  <div className="cd-menu panel" role="menu">
                    {updateTemplates.map((t) => (
                      <button key={t.id} type="button" role="menuitem" className="cd-menu-item" disabled={busy}
                        onClick={async () => { setMenu(false); const r = await run(() => sendMessage(id, t.id)); if (r) toast.ok(`${t.title} sent · ${t.code}${r.delivery?.simulated ? ' · delivery simulated in demo' : ''}`); }}>
                        <span className="mono tiny muted">{t.code}</span><span className="grow">{t.title}</span><span className="tiny muted">{CHANNEL_LABEL[t.kind] || t.kind}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {canAct && <Button icon="flag" onClick={() => setModal({ k: 'esc' })}>Raise escalation</Button>}
          {canAct && <Button icon="alert" onClick={() => setModal({ k: 'complaint' })}>Log complaint</Button>}
          {canAct && open && <Button kind="danger" icon="alert" onClick={() => setModal({ k: 'emergency' })}>Emergency</Button>}
          {canAct && open && <Button kind="ghost" icon="x" onClick={() => setModal({ k: 'cancel' })}>Cancel case</Button>}
          {canReopen && !open && <Button icon="return" onClick={() => setModal({ k: 'reopen' })}>Reopen</Button>}
        </div>
      </div>

      {onCall && <div className="mt-8"><LiveCallBar call={active} /></div>}
      {c.stage === 'cancelled' && (
        <div className="cd-banner danger mt-8"><Icon name="x" size={14} /><span><strong>Cancelled</strong> at {STAGE_LABEL[cancelledFrom] || 'an earlier stage'}{c.cancel_reason ? ` · ${c.cancel_reason}` : ''}</span></div>
      )}
      {c.stage === 'closed' && (
        <div className="cd-banner ok mt-8"><Icon name="check" size={14} /><span><strong>Closed</strong> {dateTime(c.closed_at)}{c.reopen_reason ? ` · previously reopened: ${c.reopen_reason}` : ''}</span></div>
      )}

      {/* ---------- stepper */}
      {!can('provider') && <Stepper c={c} hist={hrows} loading={hist.loading} cancelledFrom={cancelledFrom} />}

      <div className="grid g-main-side mt-12 cd-grid">
        <div className="col gap-12 cd-main">
          {!can('provider') && <GateCard c={c} gates={gates} canAct={canAct} />}
          {!can('provider') && <TransitionPanel c={c} services={services.data || []} people={people.data || []} items={items.data || []} canAct={canAct && open} can={can} profile={profile} />}
          <ServicesQuote c={c} items={items} services={services.data || []} templates={tpl} approvals={appr.data || []} canAct={canAct} band={workspace?.discount_band_pct} />
          {phase >= 2 && <Booking c={c} coordinators={(people.data || []).filter((p) => p.role === 'coordinator')} templates={tpl} canAct={canAct} me={profile} />}
          {phase >= 2 && <FieldPanel c={c} items={items.data || []} asg={asg} staff={(people.data || []).filter((p) => p.role === 'field_staff')} canDispatch={canDispatch && open} />}
          {(phase >= 3 || (samples.data || []).length > 0) && <LabPanel c={c} samples={samples} canAct={canAct && open} />}
          {(phase >= 2 || (pays.data || []).length > 0) && <PaymentPanel c={c} pays={pays} canAct={canAct && open} canReconcile={can('supervisor', 'coordinator')} allowCash={!!workspace?.settings?.allow_cash} />}
          {(c.stage === 'closure' || c.feedback_rating != null) && <Feedback c={c} canAct={canAct && c.stage === 'closure'} />}
          <BottomTabs c={c} inter={inter} calls={calls} escs={escs} cmps={cmps} ids={[...(pays.data || []), ...(asg.data || []), ...(samples.data || []), ...(escs.data || []), ...(cmps.data || []), ...(appr.data || [])].map((x) => x.id)} canNote={canAct || can('provider')} />
        </div>

        <div className="col gap-12 cd-side">
          {!can('provider') && <BriefCard c={c} brief={brief} canAct={canAct} />}
          <ProvidersPanel c={c} refs={refs} canRefer={(canAct || can('client_manager')) && open} />
          <RequirementsPanel c={c} canEdit={canAct && open} branches={workspace?.settings?.branches || []} />
          <PatientPanel c={c} canAct={canAct && open} />
          {!can('provider') && <SlaPanel timers={timers} />}
          {!can('provider') && <OpenItems c={c} gates={gates.data} escs={escs.data} cmps={cmps.data} appr={appr.data} pays={pays.data} phase={phase} />}
        </div>
      </div>

      {/* ---------- modals */}
      {modal?.k === 'esc' && <EscalationModal onClose={() => setModal(null)} onSave={async (type, text) => { const r = await run(() => insertEsc(type, text), `Escalation raised · ${type} · L1`); if (r !== undefined) setModal(null); }} busy={busy} />}
      {modal?.k === 'complaint' && <ComplaintModal busy={busy} onClose={() => setModal(null)} onSave={async (f) => {
        const r = await run(() => q(db.from('complaints').insert({ workspace_id: profile.workspace_id, case_id: id, patient_id: c.patient_id, opened_by: profile.id, ...f })), 'Complaint logged · supervisor notified');
        if (r !== undefined) setModal(null);
      }} />}
      {modal?.k === 'emergency' && <EmergencyModal script={s09} busy={busy} onClose={() => setModal(null)} onRaise={() => run(() => insertEsc('emergency', `Emergency at home reported on ${c.case_no}: caller advised to dial 108; Hinduja clinical notified`))} />}
      {modal?.k === 'cancel' && (
        <Confirm title={`Cancel ${c.case_no}?`} danger needReason reasonLabel="Cancellation reason" confirmLabel="Cancel case" busy={busy} onClose={() => setModal(null)}
          onConfirm={async (reason) => { await run(() => rpc('cancel_case', { p_case: id, p_reason: reason }), 'Case cancelled'); setModal(null); }}>
          <p className="small">Open field visits are cancelled and SLA timers stop. The case can be reopened by a coordinator or supervisor.</p>
        </Confirm>
      )}
      {modal?.k === 'reopen' && (
        <Confirm title={`Reopen ${c.case_no}?`} needReason reasonLabel="Reason for reopening" confirmLabel="Reopen case" busy={busy} onClose={() => setModal(null)}
          onConfirm={async (reason) => { await run(() => rpc('reopen_case', { p_case: id, p_reason: reason }), 'Case reopened'); setModal(null); }}>
          <p className="small">The case returns to the stage it was in before it was {c.stage}. The reason is kept in the audit trail.</p>
        </Confirm>
      )}
    </div>
  );
}

/* =========================================================== header pieces */

function DetailSkeleton() {
  return (
    <div className="cd">
      <div className="panel cd-head"><div className="grow"><div className="sk" style={{ height: 26, width: 260 }} /><div className="sk mt-8" style={{ height: 12, width: '70%' }} /></div></div>
      <div className="sk mt-12" style={{ height: 58 }} />
      <div className="grid g-main-side mt-12">
        <div className="col gap-12">{[0, 1, 2].map((i) => <Panel key={i} title={<div className="sk" style={{ height: 12, width: 120 }} />}><Skeleton lines={4} /></Panel>)}</div>
        <div className="col gap-12">{[0, 1].map((i) => <Panel key={i} title={<div className="sk" style={{ height: 12, width: 100 }} />}><Skeleton lines={5} /></Panel>)}</div>
      </div>
    </div>
  );
}

function Stepper({ c, hist, loading, cancelledFrom }) {
  const reached = c.stage === 'closed' ? STAGES.length : c.stage === 'cancelled' ? stageIndex(cancelledFrom) : stageIndex(c.stage);
  const stamp = (s) => [...hist].reverse().find((h) => h.to_stage === s)?.changed_at;
  return (
    <div className="stepper mt-12 cd-stepper" aria-label="Case stages">
      {STAGES.map((s, i) => {
        const done = i < reached;
        const cur = i === reached && c.stage !== 'closed';
        const x = cur && c.stage === 'cancelled';
        const ts = stamp(s);
        return (
          <div key={s} className={`step ${done ? 'done' : ''} ${cur && !x ? 'cur' : ''} ${x ? 'x' : ''}`} aria-current={cur ? 'step' : undefined}>
            <div className="row between"><span className="n">{String(i + 1).padStart(2, '0')}</span>{done && <Icon name="check" size={12} />}{x && <Icon name="x" size={12} />}</div>
            <div className="lbl">{STAGE_LABEL[s]}</div>
            <div className="ts">{loading ? ' ' : ts && (done || cur) ? `${date(ts)} ${time(ts)}` : x ? 'Cancelled' : DASH}</div>
          </div>
        );
      })}
    </div>
  );
}

function GateCard({ c, gates, canAct }) {
  const [run, busy] = useAction();
  const [err, setErr] = useState(null);
  const [note, setNote] = useState('');
  const g = gates.data;
  useEffect(() => setErr(null), [c.stage]);
  if (!isOpenStage(c.stage)) return null;
  const next = g?.next;
  const label = next === 'closed' ? 'Close case' : `Advance to ${STAGE_LABEL[next] || next}`;
  const advance = async () => {
    setErr(null);
    await run(async () => {
      try { await rpc('advance_case', { p_case: c.id, p_note: note.trim() || null }); setNote(''); }
      catch (e) { setErr(e.message); throw e; }
    }, next === 'closed' ? 'Case closed' : `Moved to ${STAGE_LABEL[next]}`);
  };
  return (
    <Panel title={<span className="row gap-8"><Icon name="lock" size={14} /><h3>Stage gate · {STAGE_LABEL[c.stage]}</h3></span>}
      sub={next ? `All checks must pass before ${next === 'closed' ? 'closing' : `moving to ${STAGE_LABEL[next]}`}` : null}
      actions={g && <Badge kind={g.ready ? 'ok' : 'warn'}>{g.ready ? 'Ready' : `${g.checks.filter((x) => !x.ok).length} pending`}</Badge>}>
      {!g ? <Skeleton lines={3} /> : (
        <div className="cd-gate">
          <ul className="cd-checks">
            {g.checks.map((x) => (
              <li key={x.label} className={x.ok ? 'ok' : 'no'}>
                <span className="cd-check-icon"><Icon name={x.ok ? 'check' : 'x'} size={12} stroke={1.8} /></span>{x.label}
              </li>
            ))}
          </ul>
          {canAct && next && (
            <div className="cd-advance">
              <Input className="sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the stage history (optional)" aria-label="Stage note" />
              <Button kind="primary" icon="chevron" disabled={!g.ready || busy} onClick={advance}>{label}</Button>
            </div>
          )}
          {err && <div className="cd-err mt-8"><Icon name="alert" size={13} />{err}</div>}
        </div>
      )}
    </Panel>
  );
}

/* =========================================================== side column */

function BriefCard({ c, brief, canAct }) {
  const [run, busy] = useAction();
  const now = useNow(60000);
  const riskKind = { high: 'danger', medium: 'warn', low: 'ok' }[brief?.risk] || '';
  return (
    <div className="ai-box">
      <div className="ai-head">
        <span className="row gap-8"><AiTag>AI brief</AiTag>{brief?.generated_at && <span className="tiny muted">{agoC(brief.generated_at, now)}</span>}</span>
        {canAct && brief && <Button size="xs" kind="ghost" icon="refresh" disabled={busy} onClick={() => run(() => aiBrief(c.id), 'Brief refreshed')}>Refresh</Button>}
      </div>
      {busy && !brief ? <Skeleton lines={4} /> : brief ? (
        <div className="col gap-8">
          <p className="small">{brief.summary}</p>
          {brief.next_action && <div><div className="upper">Next action</div><div className="small mt-4">{brief.next_action}</div></div>}
          <div className="row wrap gap-8">
            {brief.owner && <Badge kind="outline">Owner: {brief.owner}</Badge>}
            {brief.risk && <Badge kind={riskKind} dot>Risk {brief.risk}</Badge>}
          </div>
          {brief.risk_reason && <div className="tiny muted">{brief.risk_reason}</div>}
          {brief.patient_message_hint && <div className="tiny"><span className="muted">Suggested message:</span> {brief.patient_message_hint}</div>}
          <div className="tiny faint">Advisory only. Review before acting.</div>
        </div>
      ) : (
        <div className="col gap-8">
          <p className="small muted">No brief yet for this case. The brief reads the timeline, gates and SLA timers and suggests the next step.</p>
          {canAct && <div><Button size="sm" icon="ai" disabled={busy} onClick={() => run(() => aiBrief(c.id), 'Brief generated')}>{busy ? 'Generating' : 'Generate brief'}</Button></div>}
        </div>
      )}
    </div>
  );
}

/* =========================================================== providers and requirements */

function ProvidersPanel({ c, refs, canRefer }) {
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const [run, busy] = useAction();
  const providers = useLoad(() => (canRefer ? q(db.from('providers').select('id,code,name').is('active', true).order('code', { ascending: false })) : []), [canRefer]);
  const rows = refs.data || [];
  const others = (providers.data || []).filter((p) => !rows.some((r) => r.provider_id === p.id && !['cancelled', 'declined'].includes(r.status)));
  const send = () => run(async () => { await rpc('refer_case', { p_case: c.id, p_provider: pick, p_note: note.trim() || null }); setPick(''); setNote(''); refs.reload(); }, 'Lead sent');
  return (
    <Panel title="Providers" sub="Who delivers this case. Shared: case ID, patient details, requirements. Never recordings.">
      {refs.loading ? <Skeleton lines={2} /> : rows.length ? (
        <div className="col gap-12">
          {rows.map((r) => (
            <div key={r.id} className="col gap-4">
              <div className="row between"><strong className="small">{r.provider_name}</strong><RefBadge status={r.status} /></div>
              <div className="tiny muted">{r.service_names || (r.categories || []).join(', ') || 'Sent by hand'}{r.assigned_name ? ` · ${r.assigned_name}` : ''}</div>
              {r.scheduled_at && r.status === 'scheduled' && <div className="tiny">Visit {dateTime(r.scheduled_at)}</div>}
              {r.decline_reason && r.status === 'declined' && <div className="tiny danger-text">Declined: {r.decline_reason}</div>}
              {r.last_note && r.status !== 'declined' && <div className="tiny muted">Last note: {r.last_note}</div>}
              <LeadActions lead={r} onDone={refs.reload} />
            </div>
          ))}
        </div>
      ) : <div className="small muted">Not sent to a provider yet. Add services, or send it by hand below.</div>}
      {canRefer && others.length > 0 && (
        <div className="col gap-8 mt-12">
          <hr />
          <Select value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Send to provider..." options={others.map((p) => [p.id, p.name])} />
          {pick && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the provider (optional)" />}
          {pick && <div><Button size="sm" kind="primary" disabled={busy} onClick={send}>Send lead</Button></div>}
        </div>
      )}
    </Panel>
  );
}

function RequirementsPanel({ c, canEdit, branches }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({});
  const [run, busy] = useAction();
  const start = () => { setF({ branch: c.branch || '', services_requested: c.services_requested || '', additional_info: c.additional_info || '' }); setEdit(true); };
  const save = () => run(async () => {
    await q(db.from('cases').update({ branch: f.branch || null, services_requested: f.services_requested.trim() || null, additional_info: f.additional_info.trim() || null }).eq('id', c.id));
    setEdit(false);
  }, 'Requirements saved');
  return (
    <Panel title="Requirements" actions={canEdit && <Button size="xs" kind="ghost" icon="edit" onClick={start}>Edit</Button>}>
      <dl className="kv">
        <dt>Branch</dt><dd>{c.branch || <span className="warn-text">Not set</span>}</dd>
        <dt>Request</dt><dd className="small">{c.services_requested || DASH}</dd>
        <dt>Additional info</dt><dd className="small" style={{ whiteSpace: 'pre-wrap' }}>{c.additional_info || DASH}</dd>
        {c.external_ref && <><dt>Old CRM ID</dt><dd className="mono small">{c.external_ref}</dd></>}
      </dl>
      {edit && (
        <Modal title={`Requirements · ${c.case_no}`} onClose={() => setEdit(false)} footer={<><Button onClick={() => setEdit(false)}>Cancel</Button><Button kind="primary" disabled={busy} onClick={save}>Save</Button></>}>
          <div className="form-grid">
            <Field label="Branch"><Select value={f.branch} onChange={(e) => setF((x) => ({ ...x, branch: e.target.value }))} placeholder="Not set" options={branches} /></Field>
            <Field label="Request" hint="as the caller said it" className="span2"><Input value={f.services_requested} onChange={(e) => setF((x) => ({ ...x, services_requested: e.target.value }))} /></Field>
            <Field label="Additional information" hint="customer requirements, timings, preferences" className="span2"><Textarea rows={4} value={f.additional_info} onChange={(e) => setF((x) => ({ ...x, additional_info: e.target.value }))} /></Field>
          </div>
        </Modal>
      )}
    </Panel>
  );
}

function PatientPanel({ c, canAct }) {
  const [run, busy] = useAction();
  const consent = c.consent_verbal_at || c.consent_digital_at;
  return (
    <Panel title="Patient & consent" actions={<Link className="small" to={`/patients/${c.patient_id}`}>Patient record</Link>}>
      <dl className="kv">
        <dt>Patient</dt><dd><strong>{c.patient_name}</strong>{ageGender(c) && <span className="muted"> · {ageGender(c)}</span>}</dd>
        <dt>Mobile</dt><dd className="mono">{c.patient_mobile || DASH}</dd>
        <dt>Caller</dt><dd>{c.caller_name || DASH}{c.caller_relation ? <span className="muted"> · {c.caller_relation}</span> : null}{c.caller_mobile_display ? <div className="mono small muted">{c.caller_mobile_display}</div> : null}</dd>
        <dt>Address</dt><dd>{c.address || <span className="danger-text">Missing</span>}</dd>
        <dt>Landmark</dt><dd>{c.patient_landmark || DASH}</dd>
        <dt>Locality</dt><dd>{c.patient_locality || DASH}</dd>
        <dt>Pincode · zone</dt><dd><span className="mono">{c.pincode || DASH}</span> · {c.zone_name || <span className="warn-text">Unmapped</span>}</dd>
        {c.preferred_slot && <><dt>Preferred slot</dt><dd>{dateTime(c.preferred_slot)}</dd></>}
        {c.clinical_notes && <><dt>Clinical notes</dt><dd className="small">{c.clinical_notes}</dd></>}
      </dl>
      <hr />
      <div className="upper mb-8">Consent (DPDP)</div>
      <div className="col gap-4 small">
        <div className="row between"><span>Verbal, on recorded call</span>{c.consent_verbal_at ? <Badge kind="ok">{dateTime(c.consent_verbal_at)}</Badge> : <Badge kind="warn">Not recorded</Badge>}</div>
        <div className="row between"><span>Digital, at visit</span>{c.consent_digital_at ? <Badge kind="ok">{dateTime(c.consent_digital_at)}</Badge> : <Badge>Pending</Badge>}</div>
      </div>
      {canAct && !c.consent_verbal_at && (
        <Button className="mt-12" size="sm" icon="check" disabled={busy} onClick={() => run(() => rpc('record_consent', { p_patient: c.patient_id, p_kind: 'verbal', p_call: null }), 'Verbal consent recorded')}>Record verbal consent</Button>
      )}
      {!consent && <div className="tiny warn-text mt-8">No consent on file: the enquiry cannot move to pricing.</div>}
    </Panel>
  );
}

function SlaPanel({ timers }) {
  const rows = timers.data || [];
  return (
    <Panel title="SLA timers" sub="This case, including complaint timers" tight>
      {timers.loading ? <div className="panel-body"><Skeleton lines={3} /></div> : rows.length ? rows.map((t) => (
        <div key={t.id} className="list-row">
          <div className="grow">
            <div className="small strong">{SLA_LABEL[t.policy_key] || t.policy_key}</div>
            <div className="tiny muted">Started {time(t.started_at)} · due {dateTime(t.due_at)}</div>
          </div>
          {t.status === 'running' ? <Countdown due={t.due_at} compact />
            : t.status === 'met' ? <Badge kind="ok">Met {time(t.met_at)}</Badge>
              : t.status === 'breached' ? <Badge kind="danger">Breached{t.met_at ? `, met ${time(t.met_at)}` : ''}</Badge>
                : <Badge>Stopped</Badge>}
        </div>
      )) : <Empty title="No SLA timers yet">Timers start at pricing, quote, booking and dispatch.</Empty>}
    </Panel>
  );
}

function OpenItems({ c, gates, escs, cmps, appr, pays, phase }) {
  const list = [];
  (escs || []).filter((e) => e.status !== 'resolved').forEach((e) => list.push({ k: e.id, icon: 'flag', tone: ['clinical', 'emergency'].includes(e.type) ? 'danger' : 'warn', t: `Escalation L${e.level} · ${e.type}`, d: e.trigger_text, to: '/escalations' }));
  (cmps || []).filter((k) => ['open', 'acknowledged'].includes(k.status)).forEach((k) => list.push({ k: k.id, icon: 'alert', tone: k.severity === 'routine' ? 'warn' : 'danger', t: `Complaint ${k.ref_no || ''} · ${k.status}`, d: k.description, to: '/complaints' }));
  (appr || []).filter((a) => a.status === 'pending').forEach((a) => list.push({ k: a.id, icon: 'stamp', tone: 'warn', t: 'Waiting for Hinduja approver', d: a.title, to: '/approvals' }));
  const outstanding = Math.max(0, Number(c.total) - Number(c.amount_collected));
  if (phase >= 4 && outstanding > 0 && isOpenStage(c.stage)) list.push({ k: 'due', icon: 'rupee', tone: 'warn', t: `${inr(outstanding)} outstanding`, d: 'Collect via UPI, payment link or card' });
  const unrec = (pays || []).filter((p) => !p.reconciled);
  if (unrec.length) list.push({ k: 'rec', icon: 'rupee', tone: unrec.some((p) => p.exception) ? 'danger' : '', t: `${unrec.length} payment${unrec.length > 1 ? 's' : ''} not reconciled`, d: unrec.some((p) => p.exception) ? 'Exception raised' : 'Match against gateway or bank' });
  if (gates && isOpenStage(c.stage)) gates.checks.filter((x) => !x.ok).forEach((x) => list.push({ k: 'g' + x.label, icon: 'lock', tone: '', t: x.label, d: `Gate for ${STAGE_LABEL[gates.next] || gates.next}` }));
  return (
    <Panel title="Open items" actions={list.length ? <Badge kind="outline">{list.length}</Badge> : null} tight>
      {list.length ? list.map((x) => (
        <div key={x.k} className="list-row">
          <span className={`cd-oi ${x.tone}`}><Icon name={x.icon} size={13} /></span>
          <div className="grow"><div className="small strong">{x.t}</div>{x.d && <div className="tiny muted truncate" title={x.d}>{x.d}</div>}</div>
          {x.to && <Link to={x.to} className="tiny">Open</Link>}
        </div>
      )) : <Empty title="Nothing open on this case" />}
    </Panel>
  );
}

/* =========================================================== services & quote */

function ServicesQuote({ c, items, services, templates, approvals, canAct, band }) {
  const toast = useToast();
  const [run, busy] = useAction();
  const editable = canAct && ['enquiry', 'pricing'].includes(c.stage);
  const rows = items.data || [];
  const [pick, setPick] = useState('');
  const [qty, setQty] = useState('1');
  const [drop, setDrop] = useState(null);
  const [pct, setPct] = useState(String(Number(c.discount_pct) || ''));
  const [reason, setReason] = useState('');
  useEffect(() => { setPct(String(Number(c.discount_pct) || '')); }, [c.discount_pct]);
  const quoteTpls = templates.filter((t) => ['whatsapp', 'sms', 'email'].includes(t.kind));
  const defaultTpl = quoteTpls.find((t) => t.code === 'T-03')?.id || quoteTpls[0]?.id || '';
  const [tplId, setTplId] = useState('');
  const tid = tplId || defaultTpl;
  const showQuote = canAct && c.stage === 'pricing';
  const preview = useLoad(() => (showQuote && tid ? rpc('render_template', { p_template: tid, p_case: c.id }) : null), [showQuote, tid, c.subtotal, c.total, c.discount_amount, rows.length]);
  const used = new Set(rows.map((r) => r.service_id));
  const avail = services.filter((s) => !used.has(s.id));
  const disc = approvals.filter((a) => a.kind === 'discount');
  const lastDisc = disc[0];
  const [qk, ql] = QUOTE_KIND[c.quote_status] || ['', c.quote_status];
  const pctNum = Number(pct || 0);
  const overBand = band != null && pctNum > Number(band);

  const add = async () => {
    if (!pick) return;
    const r = await run(() => q(db.from('case_items').insert({ case_id: c.id, service_id: pick, qty: Math.max(1, Number(qty) || 1) })), 'Service added from rate card');
    if (r !== undefined) { setPick(''); setQty('1'); }
  };
  const send = async () => {
    const r = await run(() => sendQuote(c.id, tid));
    if (r) toast.ok(`Quote sent on ${CHANNEL_LABEL[r.channel] || r.channel} using ${r.template}${r.delivery?.note ? ` · ${r.delivery.note}` : ''}`);
  };

  return (
    <Panel title="Services & quote" sub="Prices come only from the approved rate card"
      actions={<Badge kind={qk}>Quote: {ql}</Badge>} tight>
      {items.loading ? <div className="panel-body"><TableSkeleton rows={3} cols={4} /></div> : (
        <div className="table-wrap">
          <table className="t compact">
            <thead><tr><th>Service</th><th className="cd-hide-sm">Category</th><th className="num">Rate</th><th className="num">Qty</th><th className="num">Line total</th>{editable && <th />}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.excluded ? 'muted' : ''}>
                  <td><div style={r.excluded ? { textDecoration: 'line-through' } : null}>{r.service_name}{r.recommended && <> <Badge kind="outline">Recommended</Badge></>}</div>
                    <div className="tiny muted mono">{r.service_code}<span className="cd-show-sm"> · {CAT_LABEL[r.category] || r.category}</span></div>
                    {r.excluded && <div className="tiny">Dropped: {r.exclude_reason}</div>}</td>
                  <td className="small cd-hide-sm">{CAT_LABEL[r.category] || r.category}</td>
                  <td className="num">{Number(r.unit_price) > 0 ? inr(r.unit_price) : <span className="warn-text tiny">Not priced</span>}</td>
                  <td className="num">{r.qty}</td>
                  <td className="num">{r.excluded ? <span className="tiny">dropped</span> : inr(r.line_total)}</td>
                  {editable && <td className="right nowrap">{r.recommended
                    ? (r.excluded
                      ? <Button size="xs" kind="ghost" disabled={busy} onClick={() => run(() => rpc('set_item_scope', { p_item: r.id, p_included: true, p_reason: null, p_qty: null }), 'Item added back')}>Keep</Button>
                      : <Button size="xs" kind="ghost" disabled={busy} onClick={() => setDrop(r)}>Drop</Button>)
                    : <Button size="xs" kind="ghost" icon="x" aria-label={`Remove ${r.service_name}`} disabled={busy} onClick={() => run(() => q(db.from('case_items').delete().eq('id', r.id)), 'Service removed')} />}</td>}
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={editable ? 6 : 5}><div className="small muted" style={{ padding: '10px 0' }}>{c.services_requested ? <>Requested: <strong>{c.services_requested}</strong>. Add the matching rate-card services.</> : 'No services added yet.'}</div></td></tr>}
            </tbody>
            <tfoot className="cd-totals">
              <tr><td colSpan={3}>Subtotal</td><td className="cd-hide-sm" /><td className="num">{inr(c.subtotal)}</td>{editable && <td />}</tr>
              <tr><td colSpan={3}>Discount {Number(c.discount_pct) > 0 ? <span className="mono">{Number(c.discount_pct)}%</span> : null}</td><td className="cd-hide-sm" /><td className="num">{Number(c.discount_amount) > 0 ? `− ${inr(c.discount_amount)}` : inr(0)}</td>{editable && <td />}</tr>
              <tr className="grand"><td colSpan={3}>Total payable</td><td className="cd-hide-sm" /><td className="num">{inr(c.total)}</td>{editable && <td />}</tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="panel-body col gap-12">
        {editable && (
          <div className="cd-add">
            <Select value={pick} onChange={(e) => setPick(e.target.value)} placeholder="Add a service from the rate card" aria-label="Rate card service"
              options={avail.map((s) => [s.id, `${s.name} · ${Number(s.price) > 0 ? inr(s.price) : 'not priced'}${s.unit && s.unit !== 'unit' ? ` per ${s.unit}` : ''} · ${CAT_LABEL[s.category] || s.category}`])} />
            <Input type="number" min="1" style={{ width: 80 }} value={qty} onChange={(e) => setQty(e.target.value)} aria-label="Quantity" />
            <Button icon="plus" disabled={!pick || busy} onClick={add}>Add service</Button>
          </div>
        )}

        {drop && (
          <Confirm title={`Drop ${drop.service_name}`} confirmLabel="Drop item" needReason reasonLabel="Why the family is dropping it" busy={busy} onClose={() => setDrop(null)}
            onConfirm={async (reason) => { await run(() => rpc('set_item_scope', { p_item: drop.id, p_included: false, p_reason: reason, p_qty: null }), 'Item dropped from the plan'); setDrop(null); }}>
            <div className="small muted">Recommended at the hospital validation. The reason goes on the timeline and into the MIS.{c.signoff_at ? ' The family has signed off: changing the total needs a new sign-off.' : ''}</div>
          </Confirm>
        )}
        {editable && (
          <div className="cd-discount">
            <Field label="Discount %" hint={band != null ? `band ${Number(band)}%` : null}>
              <Input type="number" min="0" max="100" step="0.5" placeholder="0" value={pct} onChange={(e) => setPct(e.target.value)} />
            </Field>
            <Field label="Reason" className="grow">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Senior citizen, repeat patient, corporate tie-up" />
            </Field>
            <Button disabled={busy || pct === '' || pctNum === Number(c.discount_pct) && !reason} onClick={() => run(async () => {
              const r = await rpc('set_discount', { p_case: c.id, p_pct: pctNum, p_reason: reason.trim() || null });
              setReason('');
              if (r?.status === 'pending_approval') toast(`Discount above the ${Number(band)}% band: quote blocked until the Hinduja approver decides`, 'error');
              return r;
            }, overBand ? null : 'Discount applied')}>Apply</Button>
          </div>
        )}
        {editable && overBand && <div className="tiny warn-text">Above the approved band. Applying sends it to the Hinduja approver and blocks the quote.</div>}

        {c.quote_status === 'pending_approval' && (
          <div className="cd-banner warn"><Icon name="stamp" size={14} />
            <div className="grow">
              <strong>Waiting for Hinduja approver</strong>
              {lastDisc && <div className="small">{lastDisc.title} · requested by {lastDisc.requested_by_name || DASH} {agoC(lastDisc.requested_at, Date.now())}{parseJson(lastDisc.payload)?.reason ? ` · "${parseJson(lastDisc.payload).reason}"` : ''}</div>}
              <div className="tiny">The quote cannot be sent until the discount is approved or reduced to the band.</div>
            </div>
          </div>
        )}
        {c.quote_status === 'rejected' && (
          <div className="cd-banner danger"><Icon name="x" size={14} />
            <div className="grow">
              <strong>Discount rejected</strong>
              {lastDisc && <div className="small">{lastDisc.decided_by_name || 'Hinduja approver'} {lastDisc.decided_at ? `· ${dateTime(lastDisc.decided_at)}` : ''}{lastDisc.decision_note ? ` · "${lastDisc.decision_note}"` : ''}</div>}
              <div className="tiny">Set the discount within the band to unblock the quote.</div>
            </div>
          </div>
        )}
        {lastDisc && lastDisc.status === 'approved' && c.quote_status !== 'pending_approval' && (
          <div className="small muted row gap-4"><Icon name="stamp" size={13} />{lastDisc.title} approved by {lastDisc.decided_by_name || 'Hinduja approver'} · {dateTime(lastDisc.decided_at)}</div>
        )}

        {canAct && c.stage === 'enquiry' && <div className="tiny muted">Advance the case to Pricing to send the quote.</div>}
        {showQuote && (
          <div className="cd-quote">
            <div className="row between wrap gap-8">
              <span className="upper">Send quote</span>
              <Select className="sm" style={{ width: 'auto' }} value={tid} onChange={(e) => setTplId(e.target.value)} aria-label="Quote template"
                options={quoteTpls.map((t) => [t.id, `${t.code} · ${t.title} · ${CHANNEL_LABEL[t.kind]}`])} />
            </div>
            <div className="cd-preview">{preview.loading ? <Skeleton lines={4} /> : preview.error ? <span className="danger-text small">{preview.error}</span> : preview.data || <span className="faint">Choose a template</span>}</div>
            <div className="row between wrap gap-8">
              <span className="tiny muted">{c.quote_sent_at ? `Last sent ${dateTime(c.quote_sent_at)}` : 'Approved template only. Delivery is logged on the timeline.'}</span>
              <Button kind="primary" icon="chat" disabled={busy || !tid || !['approved', 'sent'].includes(c.quote_status) || Number(c.subtotal) <= 0} onClick={send}>{c.quote_status === 'sent' ? 'Resend quote' : 'Send quote'}</Button>
            </div>
          </div>
        )}
        {!showQuote && c.quote_sent_at && <div className="small muted">Quote sent {dateTime(c.quote_sent_at)}</div>}
      </div>
    </Panel>
  );
}

/* =========================================================== booking */

function Booking({ c, coordinators, templates, canAct, me }) {
  const toast = useToast();
  const [run, busy] = useAction();
  const editable = canAct && c.stage === 'booking';
  const [slot, setSlot] = useState(toLocalInput(c.booked_slot || c.preferred_slot || nextSlot()));
  const [coord, setCoord] = useState(c.coordinator_id || (me.role === 'coordinator' ? me.id : ''));
  const tpls = templates.filter((t) => ['whatsapp', 'sms', 'email'].includes(t.kind) && t.code !== 'T-03');
  const [tplId, setTplId] = useState('');
  const tid = tplId || tpls.find((t) => t.code === 'T-04')?.id || '';
  useEffect(() => { if (c.booked_slot || c.preferred_slot) setSlot(toLocalInput(c.booked_slot || c.preferred_slot)); }, [c.booked_slot, c.preferred_slot]);
  useEffect(() => { if (c.coordinator_id) setCoord(c.coordinator_id); }, [c.coordinator_id]);
  const confirm = async () => {
    const r = await run(() => rpc('confirm_booking', { p_case: c.id, p_slot: fromLocalInput(slot), p_coordinator: coord || null, p_template: tid || null }));
    if (r !== undefined) toast.ok(`Booking confirmed for ${dateTime(fromLocalInput(slot))}${tid ? ' · confirmation sent' : ''}`);
  };
  return (
    <Panel title="Booking" sub="Slot, coordinator and patient confirmation"
      actions={c.booking_confirmed_at ? <Badge kind="ok">Confirmed</Badge> : <Badge kind="warn">Not confirmed</Badge>}>
      <dl className="kv mb-12">
        <dt>Booked slot</dt><dd>{c.booked_slot ? <strong>{dateTime(c.booked_slot)}</strong> : DASH}</dd>
        <dt>Confirmed</dt><dd>{c.booking_confirmed_at ? dateTime(c.booking_confirmed_at) : DASH}</dd>
        <dt>Coordinator</dt><dd>{c.coordinator_name || DASH}</dd>
      </dl>
      {editable && (
        <div className="cd-booking">
          <Field label="Slot" hint="IST"><Input type="datetime-local" value={slot} onChange={(e) => setSlot(e.target.value)} /></Field>
          <Field label="Coordinator"><Select value={coord} onChange={(e) => setCoord(e.target.value)} placeholder="Choose" options={coordinators.map((p) => [p.id, p.full_name])} /></Field>
          <Field label="Confirmation"><Select value={tid} onChange={(e) => setTplId(e.target.value)} placeholder="No message" options={tpls.map((t) => [t.id, `${t.code} · ${t.title}`])} /></Field>
          <Button kind="primary" icon="check" disabled={busy || !slot} onClick={confirm}>{c.booking_confirmed_at ? 'Rebook' : 'Confirm booking'}</Button>
        </div>
      )}
    </Panel>
  );
}

/* =========================================================== field */

function FieldPanel({ c, items, asg, staff, canDispatch }) {
  const [modal, setModal] = useState(null);
  const rows = asg.data || [];
  const cats = [...new Set(items.map((i) => i.category))];
  const activeTasks = new Set(rows.filter((a) => !['cancelled', 'reassigned'].includes(a.status)).map((a) => a.task));
  const needed = cats.map((k) => CAT_TASK[k]).filter(Boolean);
  const defTask = needed.find((t) => !activeTasks.has(t)) || needed[0] || 'visit';
  return (
    <Panel title="Field visit" sub="Dispatch, geo-tagged check-in, checklist and sign-off"
      actions={canDispatch && <Button size="sm" icon="plus" onClick={() => setModal({ task: defTask })}>Assign</Button>} tight>
      {asg.loading ? <div className="panel-body"><TableSkeleton rows={2} cols={5} /></div> : rows.length ? rows.map((a) => {
        const ck = parseJson(a.checklist) || {};
        const live = !['completed', 'cancelled', 'reassigned'].includes(a.status);
        return (
          <div key={a.id} className={`cd-asg ${live ? '' : 'faded'}`}>
            <div className="row wrap gap-8">
              <strong>{a.staff_name}</strong>
              <Badge kind="outline">{TASK_LABEL[a.task] || a.task}</Badge>
              <Badge kind={ASG_KIND[a.status]}>{ASG_LABEL[a.status] || a.status}</Badge>
              {a.backup_for && <Badge kind="plum">Backup</Badge>}
              <span className="grow" />
              {canDispatch && live && <Button size="xs" icon="return" onClick={() => setModal({ task: a.task, backup: a })}>Assign backup</Button>}
            </div>
            <div className="cd-asg-grid small">
              <span><span className="muted">ETA</span> {a.eta ? dateTime(a.eta) : DASH}</span>
              <span><span className="muted">Check-in</span> {a.checkin_at ? <>{time(a.checkin_at)}{a.checkin_distance_m != null && <Badge kind={a.checkin_distance_m > 250 ? 'warn' : 'ok'} className="ml-4">{a.checkin_distance_m} m</Badge>}</> : DASH}</span>
              <span><span className="muted">Done</span> {a.checkout_at ? time(a.checkout_at) : DASH}</span>
              <span className="row gap-4 wrap">
                {[['consent', 'Consent'], ['id_check', 'ID'], ['procedure', 'Procedure']].map(([k, l]) => (
                  <span key={k} className={`cd-tick ${ck[k] ? 'ok' : ''}`}><Icon name={ck[k] ? 'check' : 'x'} size={11} />{l}</span>
                ))}
                <span className={`cd-tick ${a.patient_signoff ? 'ok' : ''}`}><Icon name={a.patient_signoff ? 'check' : 'x'} size={11} />Sign-off</span>
              </span>
            </div>
            {a.delay_reason && <div className="tiny warn-text mt-4">Delay: {a.delay_reason}</div>}
          </div>
        );
      }) : <Empty title="No field staff assigned">{canDispatch ? `Assign a ${TASK_LABEL[defTask].toLowerCase()} technician once the slot is confirmed.` : 'The coordinator assigns field staff after booking.'}</Empty>}
      {modal && <AssignModal c={c} staff={staff} task={modal.task} backup={modal.backup} onClose={() => setModal(null)} />}
    </Panel>
  );
}

function AssignModal({ c, staff, task: t0, backup, onClose }) {
  const [run, busy] = useAction();
  const [task, setTask] = useState(t0);
  const fit = staff.filter((s) => task === 'visit' || (s.skills || []).includes(task));
  const [who, setWho] = useState('');
  const [eta, setEta] = useState(toLocalInput(c.booked_slot || new Date(Date.now() + 3600e3).toISOString()));
  useEffect(() => { if (!fit.some((s) => s.id === who)) setWho(''); }, [task]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const r = await run(() => rpc('assign_staff', { p_case: c.id, p_staff: who, p_task: task, p_eta: fromLocalInput(eta), p_backup_for: backup?.id || null }),
      backup ? 'Backup assigned · original visit marked reassigned' : 'Field staff assigned · notified on their phone');
    if (r !== undefined) onClose();
  };
  return (
    <Modal title={backup ? `Assign backup for ${backup.staff_name}` : `Assign field staff · ${c.case_no}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!who || busy} onClick={save}>{backup ? 'Assign backup' : 'Assign'}</Button></>}>
      <div className="form-grid">
        <Field label="Task"><Select value={task} onChange={(e) => setTask(e.target.value)} options={Object.entries(TASK_LABEL)} /></Field>
        <Field label="ETA" hint="IST"><Input type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} /></Field>
        <Field label={`Staff with ${TASK_LABEL[task].toLowerCase()} skill`} className="span2">
          <Select value={who} onChange={(e) => setWho(e.target.value)} placeholder={fit.length ? 'Choose staff' : 'Nobody has this skill'}
            options={fit.filter((s) => s.id !== backup?.staff_id).map((s) => [s.id, `${s.full_name}${s.on_duty ? ' · on duty' : ''} · ${(s.skills || []).join(', ') || 'no skills listed'}`])} />
        </Field>
      </div>
      {backup && <p className="small muted mt-12">The current visit is marked reassigned and the backup takes over the same window.</p>}
      {c.booked_slot && <p className="tiny muted mt-8">Booked slot {dateTime(c.booked_slot)} · arrival SLA ±15 min</p>}
    </Modal>
  );
}

/* =========================================================== lab */

function LabPanel({ c, samples, canAct }) {
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null);
  const rows = samples.data || [];
  const nextHop = (s) => HOPS.find(([k]) => s[k] == null);
  const update = (s) => {
    const h = nextHop(s);
    if (!h) return;
    if (h[0] === 'transport_temp_c') { setModal({ k: 'temp', s }); return; }
    run(() => rpc('upsert_sample', { p: { case_id: c.id, barcode: s.barcode, kind: s.kind, [h[0]]: new Date().toISOString() } }), `${s.barcode} · ${h[1]} recorded`);
  };
  return (
    <Panel title="Lab & chain of custody" sub="Barcode to report, every hop time-stamped"
      actions={canAct && <>
        <Button size="sm" icon="plus" onClick={() => setModal({ k: 'add' })}>Add sample</Button>
        {rows.length > 0 && <Button size="sm" kind="danger" icon="alert" onClick={() => setModal({ k: 'critical' })}>Flag critical value</Button>}
      </>}>
      {samples.loading ? <Skeleton lines={3} /> : rows.length ? (
        <div className="col gap-12">
          {rows.map((s) => {
            const h = nextHop(s);
            return (
              <div key={s.id} className={`cd-sample ${s.critical_flag ? 'crit' : ''}`}>
                <div className="row wrap gap-8">
                  <span className="mono strong">{s.barcode}</span><Badge kind="outline">{s.kind}</Badge>
                  {s.critical_flag && <Badge kind="danger" dot>Critical value</Badge>}
                  <span className="grow" />
                  {canAct && h && <Button size="xs" icon="chevron" disabled={busy} onClick={() => update(s)}>Record {h[1].toLowerCase()}</Button>}
                  {!h && <Badge kind="ok">Delivered</Badge>}
                </div>
                <ol className="cd-hops">
                  {HOPS.map(([k, l]) => {
                    const v = s[k];
                    const done = v != null;
                    return (
                      <li key={k} className={done ? 'done' : h?.[0] === k ? 'next' : ''}>
                        <span className="cd-hop-dot" />
                        <span className="cd-hop-l">{l}</span>
                        <span className="cd-hop-v mono">{!done ? DASH : k === 'transport_temp_c' ? `${Number(v).toFixed(1)}°C` : time(v)}</span>
                      </li>
                    );
                  })}
                </ol>
                {s.critical_note && <div className="tiny danger-text mt-4">Critical: {s.critical_note}</div>}
              </div>
            );
          })}
        </div>
      ) : <Empty title="No samples yet">The technician barcodes samples at the visit. ECG and X-ray captures are tracked here too.</Empty>}

      <hr />
      <div className="row wrap between gap-8">
        <span className="small"><span className="muted">Report status</span> {c.report_delivered_at && <span className="tiny muted">· delivered {dateTime(c.report_delivered_at)}</span>}</span>
        {canAct ? (
          <Segmented value={c.report_status} onChange={(v) => v !== c.report_status && run(() => rpc('set_report_status', { p_case: c.id, p_status: v }), `Report marked ${v}`)}
            options={[['pending', 'Pending'], ['released', 'Released'], ['delivered', 'Delivered'], ['na', 'Not applicable']]} />
        ) : <Badge kind={c.report_status === 'delivered' ? 'ok' : c.report_status === 'released' ? 'accent' : ''}>{c.report_status}</Badge>}
      </div>

      {modal?.k === 'add' && <SampleModal c={c} onClose={() => setModal(null)} />}
      {modal?.k === 'temp' && <TempModal c={c} s={modal.s} onClose={() => setModal(null)} />}
      {modal?.k === 'critical' && <CriticalModal c={c} samples={rows} onClose={() => setModal(null)} />}
    </Panel>
  );
}

function SampleModal({ c, onClose }) {
  const [run, busy] = useAction();
  const [barcode, setBarcode] = useState(`${(c.case_no || 'HHC').replace(/-/g, '').slice(-9)}-${Math.floor(10 + Math.random() * 89)}`);
  const [kind, setKind] = useState('blood');
  const save = async () => {
    const r = await run(() => rpc('upsert_sample', { p: { case_id: c.id, barcode: barcode.trim(), kind, collected_at: new Date().toISOString() } }), 'Sample barcoded · collection time-stamped');
    if (r !== undefined) onClose();
  };
  return (
    <Modal title="Add sample" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!barcode.trim() || busy} onClick={save}>Add sample</Button></>}>
      <div className="form-grid">
        <Field label="Barcode"><Input className="mono" value={barcode} onChange={(e) => setBarcode(e.target.value)} autoFocus /></Field>
        <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value)} options={[['blood', 'Blood'], ['urine', 'Urine'], ['ecg', 'ECG trace'], ['xray', 'X-ray image'], ['other', 'Other']]} /></Field>
      </div>
      <p className="tiny muted mt-8">Collection time is set to now. Scan the tube label where a scanner is available.</p>
    </Modal>
  );
}

function TempModal({ c, s, onClose }) {
  const [run, busy] = useAction();
  const [t, setT] = useState('4.0');
  const save = async () => {
    const r = await run(() => rpc('upsert_sample', { p: { case_id: c.id, barcode: s.barcode, kind: s.kind, transport_temp_c: Number(t) } }), 'Transport temperature recorded');
    if (r !== undefined) onClose();
  };
  const out = Number(t) < 2 || Number(t) > 8;
  return (
    <Modal title={`Transport temperature · ${s.barcode}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={t === '' || busy} onClick={save}>Record</Button></>}>
      <Field label="Temperature at handover to lab" hint="°C"><Input type="number" step="0.1" value={t} onChange={(e) => setT(e.target.value)} autoFocus /></Field>
      {out && <p className="tiny warn-text mt-8">Outside the 2 to 8°C cold-chain range. Inform the lab before accessioning.</p>}
    </Modal>
  );
}

function CriticalModal({ c, samples, onClose }) {
  const [run, busy] = useAction();
  const [bc, setBc] = useState(samples[0]?.barcode || '');
  const [note, setNote] = useState('');
  const s = samples.find((x) => x.barcode === bc);
  const save = async () => {
    const r = await run(() => rpc('upsert_sample', { p: { case_id: c.id, barcode: bc, kind: s?.kind || 'blood', critical_flag: true, critical_note: note.trim() } }), 'Critical value flagged · clinical escalation raised');
    if (r !== undefined) onClose();
  };
  return (
    <Modal title="Flag critical value" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="danger" disabled={!bc || !note.trim() || busy} onClick={save}>Flag and escalate</Button></>}>
      <div className="form-grid">
        <Field label="Sample"><Select value={bc} onChange={(e) => setBc(e.target.value)} options={samples.map((x) => [x.barcode, `${x.barcode} · ${x.kind}`])} /></Field>
        <Field label="Finding" className="span2"><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Potassium 6.8 mmol/L" autoFocus /></Field>
      </div>
      <p className="tiny muted mt-8">Raises a clinical escalation: SecondMedic medical desk and Hinduja clinical are notified with a 5 minute SLA.</p>
    </Modal>
  );
}

/* =========================================================== payment */

function PaymentPanel({ c, pays, canAct, canReconcile, allowCash }) {
  const [run, busy] = useAction();
  const [modal, setModal] = useState(null);
  const rows = pays.data || [];
  const outstanding = Math.max(0, Number(c.total) - Number(c.amount_collected));
  const [pk, pl] = PAY_KIND[c.payment_status] || ['', c.payment_status];
  return (
    <Panel title="Payment" sub="Digital collection, receipts and reconciliation"
      actions={<><Badge kind={pk}>{pl}</Badge>{canAct && outstanding > 0 && <Button size="sm" kind="primary" icon="rupee" onClick={() => setModal({ k: 'pay' })}>Record payment</Button>}</>} tight>
      <div className="cd-money">
        <div><span className="l">Total</span><span className="v mono">{inr(c.total)}</span></div>
        <div><span className="l">Collected</span><span className="v mono">{inr(c.amount_collected)}</span></div>
        <div><span className="l">Outstanding</span><span className={`v mono ${outstanding > 0 ? 'warn-text' : 'ok-text'}`}>{inr(outstanding)}</span></div>
      </div>
      {pays.loading ? <div className="panel-body"><TableSkeleton rows={2} cols={5} /></div> : rows.length ? (
        <div className="table-wrap">
          <table className="t compact">
            <thead><tr><th>Collected</th><th className="num">Amount</th><th>Mode</th><th>Txn ref</th><th>Receipt</th><th>Reconciliation</th>{canReconcile && <th />}</tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}>
                <td className="small nowrap">{dateTime(p.collected_at)}</td>
                <td className="num">{inr(p.amount)}</td>
                <td className="small">{String(p.mode).toUpperCase()}</td>
                <td className="mono small">{p.txn_ref || DASH}</td>
                <td className="mono small">{p.receipt_no || DASH}</td>
                <td>{p.reconciled ? <Badge kind="ok">Reconciled {p.reconciled_at ? date(p.reconciled_at) : ''}</Badge> : p.exception ? <Badge kind="danger" title={p.exception}>Exception: {p.exception}</Badge> : <Badge kind="warn">Pending</Badge>}</td>
                {canReconcile && <td className="right nowrap">{!p.reconciled && <>
                  <Button size="xs" icon="check" disabled={busy} onClick={() => run(() => rpc('reconcile_payment', { p_payment: p.id, p_ok: true, p_exception: null }), 'Payment reconciled')}>Reconcile</Button>{' '}
                  <Button size="xs" kind="ghost" disabled={busy} onClick={() => setModal({ k: 'exc', p })}>Exception</Button>
                </>}</td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Empty title="No payments yet">{outstanding > 0 ? `${inr(outstanding)} to collect by UPI, payment link or card.` : 'Nothing due on this case.'}</Empty>}
      {modal?.k === 'pay' && <PayModal c={c} outstanding={outstanding} allowCash={allowCash} onClose={() => setModal(null)} />}
      {modal?.k === 'exc' && (
        <Confirm title={`Reconciliation exception · ${modal.p.receipt_no || inr(modal.p.amount)}`} needReason reasonLabel="What does not match" confirmLabel="Record exception" busy={busy} onClose={() => setModal(null)}
          onConfirm={async (r) => { await run(() => rpc('reconcile_payment', { p_payment: modal.p.id, p_ok: false, p_exception: r }), 'Exception recorded'); setModal(null); }}>
          <p className="small">The payment stays unreconciled and is listed in the MIS exceptions.</p>
        </Confirm>
      )}
    </Panel>
  );
}

function PayModal({ c, outstanding, allowCash, onClose }) {
  const [run, busy] = useAction();
  const [amount, setAmount] = useState(String(outstanding));
  const [mode, setMode] = useState('upi');
  const [txn, setTxn] = useState('');
  const modes = [['upi', 'UPI'], ['link', 'Payment link'], ['card', 'Card']].concat(allowCash ? [['cash', 'Cash']] : []);
  const save = async () => {
    const r = await run(() => rpc('record_payment', { p_case: c.id, p_amount: Number(amount), p_mode: mode, p_txn: txn.trim() || null }), 'Payment recorded · receipt generated');
    if (r !== undefined) onClose();
  };
  return (
    <Modal title={`Record payment · ${c.case_no}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !(Number(amount) > 0)} onClick={save}>Record {inr(Number(amount) || 0)}</Button></>}>
      <div className="form-grid">
        <Field label="Amount" hint={`outstanding ${inr(outstanding)}`}><Input type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} className="mono" /></Field>
        <Field label="Mode"><Segmented options={modes} value={mode} onChange={setMode} /></Field>
        <Field label="Transaction reference" className="span2"><Input className="mono" value={txn} onChange={(e) => setTxn(e.target.value)} placeholder={mode === 'upi' ? 'UPI ref, 12 digits' : 'Gateway reference'} /></Field>
      </div>
      {!allowCash && <p className="tiny muted mt-8">Cash collection is off for this programme.</p>}
    </Modal>
  );
}

/* =========================================================== feedback */

function Feedback({ c, canAct }) {
  const [run, busy] = useAction();
  const [rating, setRating] = useState(c.feedback_rating ? String(c.feedback_rating) : '');
  const [text, setText] = useState(c.feedback_text || '');
  return (
    <Panel title="Patient feedback" sub="Captured at closure" actions={c.feedback_rating != null && <Badge kind={c.feedback_rating >= 4 ? 'ok' : c.feedback_rating >= 3 ? 'warn' : 'danger'}>{c.feedback_rating}/5</Badge>}>
      {canAct ? (
        <div className="col gap-8">
          <div className="row wrap gap-8"><span className="small muted">Rating</span><Segmented options={['1', '2', '3', '4', '5']} value={rating} onChange={setRating} /></div>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What the patient or family said" />
          <div><Button kind="primary" disabled={!rating || busy} onClick={() => run(() => rpc('capture_feedback', { p_case: c.id, p_rating: Number(rating), p_text: text.trim() || null }), 'Feedback captured')}>{c.feedback_rating != null ? 'Update feedback' : 'Save feedback'}</Button></div>
          {Number(rating) > 0 && Number(rating) <= 2 && <div className="tiny warn-text">Low rating: consider logging a complaint so it is tracked to resolution.</div>}
        </div>
      ) : c.feedback_rating != null ? <p className="small">{c.feedback_text || <span className="muted">No comment</span>}</p> : <Empty title="No feedback yet" />}
    </Panel>
  );
}

/* =========================================================== tabs */

function BottomTabs({ c, inter, calls, escs, cmps, ids, canNote }) {
  const { can, isOps } = useAuth();
  const canAudit = can('supervisor', 'client_manager');
  const [tab, setTab] = useState('timeline');
  const openEsc = (escs.data || []).filter((e) => e.status !== 'resolved').length + (cmps.data || []).filter((k) => ['open', 'acknowledged'].includes(k.status)).length;
  const waRows = (inter.data || []).filter((r) => r.channel === 'whatsapp');
  const tabs = [['timeline', 'Timeline', (inter.data || []).length]];
  if (!can('provider')) tabs.push(['whatsapp', 'WhatsApp', waRows.length], ['calls', 'Calls', (calls.data || []).length], ['esc', 'Escalations & complaints', openEsc]);
  if (canAudit) tabs.push(['audit', 'Audit']);
  return (
    <Panel>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'timeline' && <Timeline c={c} inter={inter} canNote={canNote} />}
      {tab === 'whatsapp' && <WhatsAppCaseTab c={c} rows={waRows} loading={inter.loading} canAct={isOps} />}
      {tab === 'calls' && <CallsTab calls={calls} />}
      {tab === 'esc' && <EscTab escs={escs} cmps={cmps} />}
      {tab === 'audit' && canAudit && <AuditTab c={c} ids={ids} />}
    </Panel>
  );
}

function WhatsAppCaseTab({ c, rows, loading, canAct }) {
  const [text, setText] = useState('');
  const [run, busy] = useAction();
  const nav = useNavigate();
  const ordered = [...rows].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const send = async (e) => {
    if (e) e.preventDefault();
    if (!text.trim() || busy) return;
    const r = await run(() => sendWhatsAppChat({ case_id: c.id, patient_id: c.patient_id, text: text.trim() }), 'WhatsApp reply sent');
    if (r !== undefined) setText('');
  };
  return (
    <div className="col gap-12">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="tiny muted">WhatsApp Business (WABA) thread for {c.patient_name} · {c.case_no}</span>
        <Button size="xs" icon="chat" onClick={() => nav(`/whatsapp?patient=${c.patient_id}`)}>Open full WhatsApp inbox</Button>
      </div>
      {loading ? <Skeleton lines={4} /> : ordered.length ? (
        <div className="wa-messages" style={{ maxHeight: 320, border: '1px solid var(--line)', borderRadius: 3 }}>
          {ordered.map((m) => {
            const outbound = m.direction === 'outbound';
            return (
              <div key={m.id} className={`wa-bubble-row ${outbound ? 'outbound' : 'inbound'}`}>
                <div className={`wa-bubble ${outbound ? 'outbound' : 'inbound'}`}>
                  <div className="wa-bubble-meta">
                    <span className="strong">{outbound ? (m.actor_label || 'CareDesk') : (c.patient_name || 'Patient')}</span>
                    <span className="mono">{dateTime(m.occurred_at)}</span>
                  </div>
                  <div className="wa-bubble-body">{m.body || m.summary || DASH}</div>
                </div>
              </div>
            );
          })}
        </div>
      ) : <Empty title="No WhatsApp messages on this case yet" />}
      {canAct && (
        <form className="row gap-8" onSubmit={send}>
          <Input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Reply to ${c.patient_name} on WhatsApp…`} />
          <Button kind="primary" type="submit" icon="send" disabled={busy || !text.trim()}>{busy ? 'Sending…' : 'Send WhatsApp'}</Button>
        </form>
      )}
    </div>
  );
}

function Timeline({ c, inter, canNote }) {
  const { profile } = useAuth();
  const [run, busy] = useAction();
  const [ch, setCh] = useState('all');
  const [note, setNote] = useState('');
  const now = useNow(60000);
  const rows = inter.data || [];
  const chans = [...new Set(rows.map((r) => r.channel))];
  const shown = ch === 'all' ? rows : rows.filter((r) => r.channel === ch);
  const today = date(new Date());
  const add = async () => {
    const t = note.trim();
    const r = await run(() => q(db.from('interactions').insert({
      workspace_id: profile.workspace_id, case_id: c.id, patient_id: c.patient_id, channel: 'note', direction: 'internal',
      actor_id: profile.id, actor_label: profile.agent_code || profile.full_name, summary: t.length > 140 ? `${t.slice(0, 137)}...` : t, body: t.length > 140 ? t : null,
    })), 'Note added');
    if (r !== undefined) setNote('');
  };
  return (
    <div>
      {canNote && (
        <div className="cd-note mb-12">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Internal note: visible to the care team and Hinduja, never sent to the patient" rows={2} />
          <Button icon="note" disabled={!note.trim() || busy} onClick={add}>Add note</Button>
        </div>
      )}
      {chans.length > 1 && (
        <div className="row wrap gap-4 mb-12">
          <button type="button" className={`pill-filter ${ch === 'all' ? 'on' : ''}`} onClick={() => setCh('all')}>All <span className="mono tiny">{rows.length}</span></button>
          {chans.map((k) => (
            <button key={k} type="button" className={`pill-filter ${ch === k ? 'on' : ''}`} onClick={() => setCh(k)}>
              <Icon name={channelIcon(k)} size={12} />{CHANNEL_LABEL[k] || k} <span className="mono tiny">{rows.filter((r) => r.channel === k).length}</span>
            </button>
          ))}
        </div>
      )}
      {inter.loading ? <Skeleton lines={6} /> : shown.length ? (
        <div className="tl">
          {shown.map((r) => (
            <div key={r.id} className="tl-item">
              <div className="tl-time">{time(r.occurred_at)}{date(r.occurred_at) !== today && <div className="tiny faint">{date(r.occurred_at)}</div>}</div>
              <div className="tl-rail"><span className={`tl-node cd-ch-${r.channel}`}><Icon name={channelIcon(r.channel)} size={11} /></span></div>
              <div className="tl-body">
                <div className="s">{r.summary}</div>
                <div className="meta">
                  {CHANNEL_LABEL[r.channel] || r.channel} · {r.direction} · {r.actor_label || 'System'} · {agoC(r.occurred_at, now)}
                  {r.evidence && <> · <Badge kind="outline">{r.evidence}</Badge></>}
                </div>
                {r.body && <div className="b">{r.body}</div>}
              </div>
            </div>
          ))}
        </div>
      ) : <Empty title={ch === 'all' ? 'No activity yet' : `No ${CHANNEL_LABEL[ch] || ch} activity`} />}
    </div>
  );
}

function CallsTab({ calls }) {
  const { can } = useAuth();
  const [run, busy] = useAction();
  const [audio, setAudio] = useState({});
  const canPlay = can('supervisor', 'coordinator', 'client_manager', 'client_clinical', 'medical_desk');
  const rows = calls.data || [];
  const play = async (cl) => {
    const url = await run(async () => {
      const u = await recordingUrl(cl.id);
      await rpc('log_access', { p_action: 'play_recording', p_entity: 'call', p_entity_id: cl.id, p_meta: {} });
      return u;
    });
    if (url) setAudio((a) => ({ ...a, [cl.id]: url }));
  };
  if (calls.loading) return <TableSkeleton rows={3} cols={4} />;
  if (!rows.length) return <Empty title="No calls linked to this case" />;
  return (
    <div className="col gap-12">
      {rows.map((cl) => (
        <div key={cl.id} className="cd-call">
          <div className="row wrap gap-8">
            <Icon name={cl.direction === 'inbound' ? 'callin' : 'callout'} size={14} />
            <strong className="small">{cl.direction === 'inbound' ? 'Inbound' : 'Outbound'}</strong>
            <Badge kind={['answered', 'completed'].includes(cl.status) ? 'ok' : ['missed', 'abandoned', 'failed'].includes(cl.status) ? 'danger' : 'warn'}>{cl.status}</Badge>
            <span className="small muted">{dateTime(cl.started_at)} · {cl.agent_label || DASH}</span>
            <span className="grow" />
            {cl.ring_seconds != null && <span className="tiny muted">ring {cl.ring_seconds} s</span>}
            {cl.talk_seconds > 0 && <span className="mono small">{dur(cl.talk_seconds)}</span>}
            {cl.has_recording && canPlay && !audio[cl.id] && <Button size="xs" icon="play" disabled={busy} onClick={() => play(cl)}>Recording</Button>}
          </div>
          {audio[cl.id] && <audio className="mt-8" controls autoPlay src={audio[cl.id]} style={{ width: '100%', height: 32 }} />}
          {cl.ai_summary && (
            <div className="cd-call-ai mt-8">
              <AiTag>AI summary</AiTag>
              <span className="small">{cl.ai_summary}</span>
              {(cl.ai_sentiment || (cl.ai_flags || []).length > 0) && (
                <div className="row wrap gap-4 mt-4">
                  {cl.ai_sentiment && <Badge kind={cl.ai_sentiment === 'distressed' ? 'warn' : 'outline'}>Sentiment: {cl.ai_sentiment}</Badge>}
                  {(cl.ai_flags || []).map((f) => <Badge key={f} kind="warn">{f}</Badge>)}
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function EscTab({ escs, cmps }) {
  const e = escs.data || [];
  const k = cmps.data || [];
  return (
    <div className="col gap-16">
      <div>
        <div className="upper mb-8">Escalations</div>
        {escs.loading ? <TableSkeleton rows={2} cols={4} /> : e.length ? (
          <div className="table-wrap"><table className="t compact">
            <thead><tr><th>Raised</th><th>Type</th><th>Trigger</th><th>By</th><th>Status</th></tr></thead>
            <tbody>{e.map((x) => (
              <tr key={x.id}>
                <td className="small nowrap">{dateTime(x.raised_at)}</td>
                <td><Badge kind={['clinical', 'emergency'].includes(x.type) ? 'danger' : 'warn'}>L{x.level} · {x.type}</Badge></td>
                <td className="small" style={{ minWidth: 200 }}>{x.trigger_text}{x.outcome && <div className="tiny muted">Outcome: {x.outcome}</div>}</td>
                <td className="small">{x.auto_raised ? 'SLA engine' : x.raised_by_name || DASH}</td>
                <td><Badge kind={x.status === 'resolved' ? 'ok' : x.status === 'acknowledged' ? 'info' : 'danger'}>{x.status}</Badge></td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No escalations on this case" />}
      </div>
      <div>
        <div className="upper mb-8">Complaints</div>
        {cmps.loading ? <TableSkeleton rows={2} cols={4} /> : k.length ? (
          <div className="table-wrap"><table className="t compact">
            <thead><tr><th>Ref</th><th>Category</th><th>Severity</th><th>Description</th><th>Status</th><th>Resolve by</th></tr></thead>
            <tbody>{k.map((x) => (
              <tr key={x.id}>
                <td className="mono small">{x.ref_no}</td>
                <td className="small">{CMP_CATS.find(([v]) => v === x.category)?.[1] || x.category}</td>
                <td><Badge kind={x.severity === 'routine' ? '' : 'danger'}>{x.severity}</Badge></td>
                <td className="small" style={{ minWidth: 200 }}>{x.description}</td>
                <td><Badge kind={['resolved', 'closed'].includes(x.status) ? 'ok' : x.status === 'acknowledged' ? 'info' : 'warn'}>{x.status}</Badge></td>
                <td>{x.resolve_due && ['open', 'acknowledged'].includes(x.status) ? <Countdown due={x.resolve_due} compact /> : <span className="small muted">{x.resolved_at ? dateTime(x.resolved_at) : DASH}</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No complaints on this case" />}
      </div>
    </div>
  );
}

const fmtVal = (v) => {
  if (v == null || v === '') return DASH;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return dateTime(s);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

function AuditTab({ c, ids }) {
  const all = useMemo(() => [c.id, ...ids], [c.id, ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const audit = useLoad(() => q(db.from('v_audit').select('id,table_name,record_id,action,changes,actor_name,actor_role,at').in('record_id', all).order('at', { ascending: false }).limit(300)), [all.join(',')], ['cases', 'payments', 'assignments', 'samples', 'escalations', 'complaints', 'approvals']);
  const rows = audit.data || [];
  if (audit.loading) return <TableSkeleton rows={5} cols={4} />;
  if (audit.error) return <ErrorNote error={audit.error} />;
  if (!rows.length) return <Empty title="No audit entries" />;
  return (
    <div className="table-wrap">
      <table className="t compact">
        <thead><tr><th>When</th><th>Who</th><th>Record</th><th>Change</th></tr></thead>
        <tbody>{rows.map((r) => {
          const ch = parseJson(r.changes);
          return (
            <tr key={r.id}>
              <td className="small nowrap">{dateTime(r.at)}</td>
              <td className="small nowrap">{r.actor_name || 'System'}</td>
              <td className="small nowrap"><span className="mono">{r.table_name}</span> · {r.action}</td>
              <td className="small">
                {r.action === 'update' && ch ? (
                  <div className="cd-diff">{Object.entries(ch).map(([k, v]) => (
                    <div key={k}><span className="mono muted">{k}</span>: <span className="cd-old">{fmtVal(v?.old)}</span> → <span className="cd-new">{fmtVal(v?.new)}</span></div>
                  ))}</div>
                ) : r.action === 'insert' ? <span className="muted">Record created</span> : <span className="muted">Record deleted</span>}
              </td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

/* =========================================================== header modals */

function EscalationModal({ onClose, onSave, busy }) {
  const [type, setType] = useState('delay');
  const [text, setText] = useState('');
  return (
    <Modal title="Raise escalation" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!text.trim() || busy} onClick={() => onSave(type, text.trim())}>Raise L1 escalation</Button></>}>
      <div className="form-grid">
        <Field label="Type"><Select value={type} onChange={(e) => setType(e.target.value)} options={ESC_TYPES} /></Field>
        <Field label="Level"><Input value="Level 1 · first owner per matrix" disabled /></Field>
        <Field label="What happened" className="span2"><Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Technician running 40 min late, patient fasting since 10 pm" autoFocus /></Field>
      </div>
      <p className="tiny muted mt-8">Clinical and emergency escalations notify the medical desk and Hinduja clinical. The matrix levels up automatically if not acknowledged.</p>
    </Modal>
  );
}

function ComplaintModal({ onClose, onSave, busy }) {
  const [category, setCategory] = useState('service');
  const [severity, setSeverity] = useState('routine');
  const [description, setDescription] = useState('');
  return (
    <Modal title="Log complaint" onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!description.trim() || busy} onClick={() => onSave({ category, severity, description: description.trim() })}>Log complaint</Button></>}>
      <div className="form-grid">
        <Field label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value)} options={CMP_CATS} /></Field>
        <Field label="Severity"><Segmented options={[['routine', 'Routine'], ['high', 'High'], ['critical', 'Critical']]} value={severity} onChange={setSeverity} /></Field>
        <Field label="Description" className="span2"><Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="In the patient's words, with times" autoFocus /></Field>
      </div>
      <p className="tiny muted mt-8">Acknowledgement SLA 15 min, resolution 48 h. High and critical complaints also notify Hinduja management.</p>
    </Modal>
  );
}

function EmergencyModal({ script, onClose, onRaise, busy }) {
  const [raised, setRaised] = useState(false);
  const raise = async () => { const r = await onRaise(); if (r !== undefined) setRaised(true); };
  return (
    <Modal title="Emergency at home" onClose={onClose}
      footer={raised ? <Button kind="primary" onClick={onClose}>Done</Button> : <><Button onClick={onClose}>Cancel</Button><Button kind="danger" icon="alert" disabled={busy} onClick={raise}>Raise emergency escalation now</Button></>}>
      {raised && <div className="cd-banner danger mb-12"><Icon name="flag" size={14} /><span><strong>Emergency escalation raised.</strong> Hinduja clinical, medical desk and supervisor notified. Stay on the line.</span></div>}
      <div className="upper mb-8">Script {script?.code || 'S-09'} · {script?.title || 'Emergency at home'}</div>
      <div className="cd-script">{script?.body || 'Do not give clinical advice. Ask the caller to dial 108 immediately, confirm the address and a callback number, raise the emergency escalation and stay on the line.'}</div>
    </Modal>
  );
}
