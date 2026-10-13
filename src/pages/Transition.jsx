// Post-discharge home care transition on the case page (SOP steps 1 to 3):
//   intake: discharge details, who we spoke with, the interaction reason (strict list)
//   on-site validation: a care coordinator (nurse) at Hinduja meets doctor, ward staff and family, records discharge
//     readiness and the recommended itemised list
//   commercials: the family keeps or drops items in Services & quote; the decision-maker's sign-off releases the
//     partner leads (diagnostics to SecondMedic, manpower and equipment to Book My Medicare)
// Every change goes through a database action (set_intake, schedule_validation, record_validation, record_signoff).
import { useState } from 'react';
import { db, q, rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { inr, date, dateTime, toLocalInput, fromLocalInput } from '../lib/fmt.js';
import { Panel, Button, Badge, Modal, Field, Input, Select, Textarea, Segmented, Check, Skeleton, useAction } from '../components/ui.jsx';

export const DISPOSITIONS = [
  ['requirement_captured', 'Requirement captured'], ['information_only', 'Information only'], ['price_enquiry', 'Price enquiry'],
  ['follow_up_requested', 'Follow-up requested'], ['not_interested', 'Not interested'], ['already_arranged', 'Already arranged elsewhere'],
  ['wrong_number', 'Wrong number'], ['duplicate', 'Duplicate enquiry'],
];
const DISP_LABEL = Object.fromEntries(DISPOSITIONS);
const SPOKE = [['patient', 'Patient'], ['decision_maker', 'Family decision-maker'], ['family_member', 'Other family member'], ['hospital_staff', 'Hospital staff']];
const SPOKE_LABEL = Object.fromEntries(SPOKE);
const VAL = { not_required: ['', 'Not required'], pending: ['warn', 'Validation pending'], scheduled: ['info', 'Visit scheduled'], done: ['ok', 'Discharge ready'], not_ready: ['danger', 'Not ready for discharge'] };
const READY = [['ready', 'Ready for discharge'], ['not_ready', 'Not ready'], ['deferred', 'Discharge deferred']];
const MODES = [['in_person', 'In person'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['phone', 'Phone (recorded call)']];
const DASH = '–';

export function TransitionPanel({ c, services, people, items, canAct, can, profile }) {
  const pd = c.care_type === 'post_discharge';
  const assess = useLoad(() => (pd ? q(db.from('v_assessments').select('*').eq('case_id', c.id).order('created_at', { ascending: false }).limit(5)) : []),
    [c.id, pd, c.validation_status], ['discharge_assessments']);
  const [edit, setEdit] = useState(false);
  const [recording, setRecording] = useState(false);
  const latest = (assess.data || [])[0];
  const early = ['enquiry', 'pricing'].includes(c.stage);
  const canSchedule = can('coordinator', 'supervisor', 'medical_desk') && early;
  const canRecord = early && (can('coordinator', 'supervisor', 'medical_desk') || (can('field_staff') && latest?.nurse_id === profile?.id && latest.status === 'scheduled'));
  const [vk, vl] = VAL[c.validation_status] || ['', c.validation_status];

  if (!pd && !c.intake_disposition && !canAct) return null;
  return (
    <Panel title={pd ? 'Post-discharge transition' : 'Intake'}
      sub={pd ? 'Intake, on-site validation at Hinduja, family sign-off. Partner leads go out only after sign-off.' : 'Interaction reason for this enquiry'}
      actions={<div className="row gap-8">{pd && <Badge kind={vk}>{vl}</Badge>}{canAct && !edit && <Button size="xs" kind="ghost" icon="edit" onClick={() => setEdit(true)}>{c.intake_disposition ? 'Edit intake' : 'Record intake'}</Button>}</div>}>
      {edit ? <IntakeForm c={c} onDone={() => setEdit(false)} /> : <IntakeView c={c} />}

      {pd && (
        <div className="col gap-12 mt-16">
          <div className="section-title">On-site clinical validation</div>
          {assess.loading ? <Skeleton lines={3} /> : latest ? <AssessmentView a={latest} /> : <div className="small muted">No hospital visit yet.</div>}
          {canSchedule && c.validation_status !== 'done' && <ScheduleForm c={c} people={people} current={latest} onDone={assess.reload} />}
          {canRecord && <div><Button size="sm" kind={c.validation_status === 'scheduled' ? 'primary' : ''} onClick={() => setRecording(true)}>
            {c.validation_status === 'done' ? 'Update validation and item list' : 'Record validation visit'}</Button></div>}
          {recording && <ValidationModal c={c} services={services} items={items} onClose={() => setRecording(false)} onDone={() => { setRecording(false); assess.reload(); }} />}

          <div className="section-title mt-8">Commercial sign-off</div>
          <SignOff c={c} canAct={canAct} />
        </div>
      )}
    </Panel>
  );
}

function IntakeView({ c }) {
  const dl = (k, v) => <><dt>{k}</dt><dd>{v || <span className="faint">{DASH}</span>}</dd></>;
  if (!c.intake_disposition) return <div className="small muted">No interaction reason recorded yet.</div>;
  return (
    <dl className="kv">
      {dl('Reason', DISP_LABEL[c.intake_disposition] || c.intake_disposition)}
      {dl('Spoke with', SPOKE_LABEL[c.spoke_with])}
      {c.care_type === 'post_discharge' && <>
        {dl('Decision-maker', [c.decision_maker_name, c.decision_maker_relation].filter(Boolean).join(', '))}
        {dl('Hospital', [c.hospital_name, c.hospital_ward].filter(Boolean).join(', '))}
        {dl('Treating doctor', c.treating_doctor)}
        {dl('Discharge', c.expected_discharge_on && date(c.expected_discharge_on))}
        {dl('Plan', `${c.plan_days} days`)}
      </>}
    </dl>
  );
}

function IntakeForm({ c, onDone }) {
  const [f, setF] = useState({
    care_type: c.care_type || 'standard', intake_disposition: c.intake_disposition || '', spoke_with: c.spoke_with || '',
    decision_maker_name: c.decision_maker_name || '', decision_maker_relation: c.decision_maker_relation || '',
    hospital_name: c.hospital_name || 'P. D. Hinduja Hospital', hospital_ward: c.hospital_ward || '', treating_doctor: c.treating_doctor || '',
    expected_discharge_on: c.expected_discharge_on || '', plan_days: String(c.plan_days || 30), clinical_status: '',
  });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? e.target.value : e }));
  const pd = f.care_type === 'post_discharge';
  const needs = pd && f.intake_disposition === 'requirement_captured';
  const ok = f.intake_disposition && (!needs || (f.spoke_with && f.expected_discharge_on));
  const save = () => run(async () => {
    await rpc('set_intake', { p_case: c.id, p: { ...f, plan_days: f.plan_days ? Number(f.plan_days) : null } });
    onDone();
  }, 'Intake saved');
  return (
    <div className="col gap-12">
      <Segmented value={f.care_type} onChange={set('care_type')} options={[['standard', 'Standard home service'], ['post_discharge', 'Post-discharge transition']]} />
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="Interaction reason"><Select value={f.intake_disposition} onChange={set('intake_disposition')} placeholder="Choose" options={DISPOSITIONS} /></Field>
        <Field label="Spoke with"><Select value={f.spoke_with} onChange={set('spoke_with')} placeholder="Choose" options={SPOKE} /></Field>
        {pd && <>
          <Field label="Decision-maker name"><Input value={f.decision_maker_name} onChange={set('decision_maker_name')} /></Field>
          <Field label="Relation to patient"><Input value={f.decision_maker_relation} onChange={set('decision_maker_relation')} placeholder="Son, spouse, daughter" /></Field>
          <Field label="Hospital"><Input value={f.hospital_name} onChange={set('hospital_name')} /></Field>
          <Field label="Ward / bed"><Input value={f.hospital_ward} onChange={set('hospital_ward')} placeholder="ICU 4, bed 12" /></Field>
          <Field label="Treating doctor"><Input value={f.treating_doctor} onChange={set('treating_doctor')} /></Field>
          <Field label="Expected discharge date"><Input type="date" value={f.expected_discharge_on} onChange={set('expected_discharge_on')} /></Field>
          <Field label="Plan length" hint="days, for the cost estimate"><Input type="number" min="1" max="365" value={f.plan_days} onChange={set('plan_days')} /></Field>
        </>}
      </div>
      {pd && <Field label="Clinical status" hint="replaces the case's clinical notes when filled">
        <Textarea rows={2} value={f.clinical_status} onChange={set('clinical_status')} placeholder="Diagnosis, current support (oxygen, feeding), mobility" />
      </Field>}
      <div className="row gap-8"><Button kind="primary" disabled={!ok || busy} onClick={save}>Save intake</Button><Button onClick={onDone}>Cancel</Button></div>
    </div>
  );
}

function AssessmentView({ a }) {
  const met = [a.met_doctor && 'doctor', a.met_ward_staff && 'ward staff', a.met_family && 'family'].filter(Boolean);
  return (
    <dl className="kv">
      <dt>Nurse</dt><dd>{a.nurse_name || DASH}</dd>
      <dt>{a.status === 'done' ? 'Visited' : 'Scheduled'}</dt><dd>{dateTime(a.status === 'done' ? a.visited_at : a.scheduled_at)}{a.status === 'scheduled' ? <>{' '}<Badge kind="info">Scheduled</Badge></> : null}</dd>
      {a.status === 'done' && <>
        <dt>Met</dt><dd>{met.length ? met.join(', ') : <span className="danger-text">nobody recorded</span>}{a.doctor_name ? ` · ${a.doctor_name}` : ''}</dd>
        <dt>Readiness</dt><dd>{(READY.find((r) => r[0] === a.readiness) || [])[1] || DASH}{a.revised_discharge_on ? ` · discharge ${date(a.revised_discharge_on)}` : ''}</dd>
        {a.home_setup_notes && <><dt>Home setup</dt><dd className="small">{a.home_setup_notes}</dd></>}
        {a.clinical_summary && <><dt>Clinical summary</dt><dd className="small">{a.clinical_summary}</dd></>}
      </>}
    </dl>
  );
}

function ScheduleForm({ c, people, current, onDone }) {
  const nurses = people.filter((p) => ['coordinator', 'field_staff'].includes(p.role));
  const [nurse, setNurse] = useState(current?.status === 'scheduled' ? current.nurse_id : '');
  const [when, setWhen] = useState(() => { const d = new Date(Date.now() + 2 * 3600e3); d.setMinutes(0, 0, 0); return toLocalInput(d.toISOString()); });
  const [run, busy] = useAction();
  const go = () => run(async () => { await rpc('schedule_validation', { p_case: c.id, p_nurse: nurse, p_when: fromLocalInput(when) }); onDone(); }, 'Hospital visit scheduled · nurse notified');
  return (
    <div className="row wrap gap-8" style={{ alignItems: 'flex-end' }}>
      <Field label="Care coordinator (nurse)"><Select value={nurse} onChange={(e) => setNurse(e.target.value)} placeholder="Choose" options={nurses.map((p) => [p.id, p.full_name])} /></Field>
      <Field label="Visit at Hinduja (IST)"><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      <Button disabled={!nurse || !when || busy} onClick={go}>{current?.status === 'scheduled' ? 'Reschedule' : 'Schedule visit'}</Button>
    </div>
  );
}

function ValidationModal({ c, services, items, onClose, onDone }) {
  const prior = (items || []).filter((i) => i.recommended).map((i) => ({ service_id: i.service_id, qty: String(i.qty) }));
  const [f, setF] = useState({ met_doctor: false, doctor_name: c.treating_doctor || '', met_ward_staff: false, met_family: false,
    readiness: 'ready', revised_discharge_on: '', home_setup_notes: '', clinical_summary: '' });
  const [list, setList] = useState(prior.length ? prior : [{ service_id: '', qty: '' }]);
  const [run, busy] = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const svc = Object.fromEntries(services.map((s) => [s.id, s]));
  const rows = list.filter((r) => r.service_id && Number(r.qty) >= 1);
  const est = rows.reduce((sum, r) => sum + Number(svc[r.service_id]?.price || 0) * Number(r.qty), 0);
  const unpriced = rows.filter((r) => Number(svc[r.service_id]?.price || 0) === 0).length;
  const ready = f.readiness === 'ready';
  const ok = !ready || (f.met_doctor && f.met_family);
  const save = () => run(async () => {
    await rpc('record_validation', { p_case: c.id, p: { ...f, revised_discharge_on: f.revised_discharge_on || null,
      items: rows.map((r) => ({ service_id: r.service_id, qty: Number(r.qty) })) } });
    onDone();
  }, 'Validation recorded');
  return (
    <Modal wide title={`Hospital validation · ${c.case_no}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!ok || busy} onClick={save}>Save validation</Button></>}>
      <div className="grid g2" style={{ gap: 16 }}>
        <div className="col gap-12">
          <div className="section-title">Who you met</div>
          <Check label="Treating doctor" checked={f.met_doctor} onChange={set('met_doctor')} />
          <Field label="Doctor's name"><Input value={f.doctor_name} onChange={set('doctor_name')} /></Field>
          <Check label="Ward staff" checked={f.met_ward_staff} onChange={set('met_ward_staff')} />
          <Check label="Family / decision-maker" checked={f.met_family} onChange={set('met_family')} />
          <Field label="Discharge readiness"><Select value={f.readiness} onChange={set('readiness')} options={READY} /></Field>
          {ready && !ok && <div className="tiny warn-text">Meet the treating doctor and the family before confirming readiness.</div>}
          <Field label="Revised discharge date" hint="if it changed"><Input type="date" value={f.revised_discharge_on} onChange={set('revised_discharge_on')} /></Field>
          <Field label="Home setup"><Textarea rows={2} value={f.home_setup_notes} onChange={set('home_setup_notes')} placeholder="Floor, lift, room size, power backup, space for an ICU bed" /></Field>
          <Field label="Clinical summary"><Textarea rows={3} value={f.clinical_summary} onChange={set('clinical_summary')} placeholder="Diagnosis, support needed at home, orders from the doctor" /></Field>
        </div>
        <div className="col gap-8">
          <div className="section-title">Recommended items</div>
          <div className="tiny muted">Quantity in the service's unit for the whole plan, e.g. two 12-hour nurses for {c.plan_days} days = {2 * c.plan_days} shifts.</div>
          {list.map((r, i) => (
            <div key={i} className="row gap-8">
              <Select className="grow" value={r.service_id} placeholder="Rate-card service" aria-label={`Item ${i + 1}`}
                onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, service_id: e.target.value } : x)))}
                options={services.map((s) => [s.id, `${s.name} · ${Number(s.price) > 0 ? `${inr(s.price)} per ${s.unit}` : 'not priced yet'}`])} />
              <Input type="number" min="1" style={{ width: 80 }} value={r.qty} aria-label={`Quantity ${i + 1}`} placeholder="Qty"
                onChange={(e) => setList((l) => l.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <Button size="xs" kind="ghost" icon="x" aria-label={`Remove item ${i + 1}`} onClick={() => setList((l) => l.filter((_, j) => j !== i))} />
            </div>
          ))}
          <div><Button size="xs" icon="plus" onClick={() => setList((l) => [...l, { service_id: '', qty: '' }])}>Add item</Button></div>
          <div className="small mt-8">{rows.length} item{rows.length === 1 ? '' : 's'} · estimate {inr(est)}{unpriced ? <span className="warn-text"> · {unpriced} not priced on the rate card yet</span> : null}</div>
          <div className="tiny muted">Saving replaces the earlier recommended list. Items added by hand on the quote stay.</div>
        </div>
      </div>
    </Modal>
  );
}

function SignOff({ c, canAct }) {
  const [f, setF] = useState({ signed_by: c.decision_maker_name || '', mode: 'in_person', plan_days: String(c.plan_days || 30), note: '' });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  if (c.signoff_at) {
    return (
      <div className="small">
        Signed off by <strong>{c.signoff_by_name}</strong> · {(MODES.find((m) => m[0] === c.signoff_mode) || [])[1] || c.signoff_mode} · {dateTime(c.signoff_at)}
        <div className="muted">{c.items_agreed} of {c.items_recommended} recommended items · {c.plan_days} days · {inr(c.total)}{c.signoff_note ? ` · ${c.signoff_note}` : ''}</div>
      </div>
    );
  }
  const blocker = c.validation_status !== 'done' ? 'On-site validation must confirm discharge readiness first.'
    : c.stage !== 'pricing' ? 'Move the case to Pricing, share the quote, then record the sign-off.'
    : !['approved', 'sent'].includes(c.quote_status) ? 'The discount needs approval before sign-off.'
    : Number(c.total) <= 0 ? 'Every agreed item needs a rate-card price before sign-off.' : null;
  if (!canAct || blocker) return <div className="small muted">{blocker || 'Not signed off yet.'}</div>;
  const save = () => run(() => rpc('record_signoff', { p_case: c.id, p: { ...f, plan_days: Number(f.plan_days) || null, note: f.note.trim() || null } }),
    'Sign-off recorded · partner leads sent');
  return (
    <div className="col gap-12">
      <div className="small">Agreed: {c.items_agreed} of {c.items_recommended} recommended items · {c.plan_days} days · <strong>{inr(c.total)}</strong></div>
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="Signed off by (decision-maker)"><Input value={f.signed_by} onChange={set('signed_by')} /></Field>
        <Field label="How"><Select value={f.mode} onChange={set('mode')} options={MODES} /></Field>
        <Field label="Plan length (days)"><Input type="number" min="1" max="365" value={f.plan_days} onChange={set('plan_days')} /></Field>
        <Field label="Note"><Input value={f.note} onChange={set('note')} placeholder="Advance paid, start date, special terms" /></Field>
      </div>
      <div><Button kind="primary" disabled={!f.signed_by.trim() || busy} onClick={save}>Record sign-off</Button></div>
    </div>
  );
}
