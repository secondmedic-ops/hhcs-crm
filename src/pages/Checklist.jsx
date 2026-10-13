// Clinical assessment & commercial closure checklist (SOP steps 2 and 3). The hospital care coordinator (nurse) prints it
// before the Hinduja visit and fills it by hand at the bedside, at the ward station and with the family.
//   Opened from a case (?case=<id>) it is prefilled: patient, hospital, decision-maker, the recommended / agreed / dropped
//   items and the plan prices. Opened on its own it prints blank.
//   Every price comes from care_plan_sheet() (rate card, plan quantities and totals computed in the database).
//   The CareDesk case stays the record: validation, items, drops and sign-off are entered there the same day.
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { inr, dateLong, dateTime, num } from '../lib/fmt.js';
import { PageHead, Button, Field, Input, Skeleton, Empty, ErrorNote, useAction } from '../components/ui.jsx';

export const CHECKLIST_ROLES = ['coordinator', 'field_staff', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'];
const FORM = 'HHCS-CL-01 · version 1.0 · Oct 2026';

// ---------- Part A: before and at the bedside ----------
const FILE_CHECK = [
  'Patient ID band matches the file (name, UHID); admission diagnosis and co-morbidities noted',
  'Latest progress note and the treating doctor\'s discharge plan read',
  'Medication chart: IV and injectables, insulin, anticoagulants, controlled drugs; last doses given',
  'Allergies and alerts (drug, latex, food); isolation status (MRSA, CRE, TB, other)',
  'Vitals trend for the last 24 hours, SpO2 on current oxygen support, GCS / orientation',
  'Recent labs (Hb, electrolytes, renal, sugars, ABG if on support) and reports still pending',
  'Lines, drains and tubes: cannula / PICC / central line, Ryles / PEG, Foley / SPC, drains, wound or VAC dressing',
  'Airway and breathing now: room air / oxygen L/min / HF flow and FiO2 / BiPAP settings / ventilator mode; tracheostomy size and last change',
  'Pressure injury risk (Braden score), existing pressure injuries (site, stage)',
  'Fall risk and mobility (bedbound, chair, assisted walking); weight for bed and mattress choice',
  'Code status or advance directive documented',
];
const DOCTOR_POINTS = [
  'Expected discharge date and the clinical criteria that must be met first',
  'Oxygen or ventilation at home: device, mode, settings, target SpO2, weaning plan',
  'Level of nursing: ICU-trained (ventilator, tracheostomy, HF oxygen) or general; 12-hour or 24-hour cover; for how long',
  'Monitoring orders: vitals frequency, sugar charting, intake and output, alarm limits',
  'Medicines at home: injectables or IV to continue, duration, who may give them',
  'Tests at home: which, how often (for example KFT twice a week), portable X-ray',
  'Physiotherapy: chest and / or limb, sessions a week',
  'Diet and feeding: oral / Ryles / PEG, feed plan, swallow assessment',
  'Red flags that need a call or readmission; whom the home team calls',
  'Follow-up OPD date and investigations before it',
  'Which items are clinically must-have and which are optional (record in Part B, column M / O)',
];
const HANDOVER = [
  'Events in the last 24 hours: desaturation, fever, fall, agitation',
  'Suction: how often, secretion type; tracheostomy care routine',
  'Feeding times, last tube change, aspiration risk',
  'Catheter: date inserted; last bowel movement',
  'Skin: pressure areas, dressings, supplies to send home',
  'Positioning schedule (for example 2-hourly turning); restraints, if any',
  'Medicine times and doses already given today',
  'Behaviour and cognition: delirium, agitation, sundowning',
  'Device make and model on the ward (so home equipment and interfaces match)',
  'Still to do before discharge: summary, prescriptions, reports, family training on devices',
];

// ---------- Part B: home readiness ----------
const EQUIPMENT = [
  ['Ventilator / BiPAP', 'Mode, IPAP / EPAP or set volume, rate, FiO2; mask or tracheostomy; internal battery hours', ['VENT-HOME']],
  ['High-flow (HF) oxygen machine', 'Flow L/min, FiO2 %, temperature; cannula size', ['HFNC']],
  ['Oxygen concentrator', '5 or 10 L/min unit; prescribed L/min; backup cylinder', ['OXY-CONC']],
  ['Suction machine', 'Catheter size (Fr); how often; portable unit for power cuts', ['SUCTION']],
  ['Hospital bed', 'Motorised ICU / semi-Fowler / Fowler; side rails', ['BED-ICU', 'BED-HOSP']],
  ['Air mattress', 'Alternating pressure; Braden score, existing pressure injury', ['AIRBED']],
  ['Multipara monitor', 'SpO2, NIBP, ECG, temperature; alarm limits', ['MONITOR']],
  ['Mini-ICU setup', 'Monitor, suction and oxygen installed together by a technician', ['MINI-ICU']],
  ['Other', 'Feeding or infusion pump, nebuliser, wheelchair, commode, walker', []],
];
const MANPOWER = [
  ['Nurse, ICU-trained', 'Ventilator, tracheostomy, HF oxygen, frequent suction', ['NURSE-12H']],
  ['Nurse, general', 'Medicines, wound care, feeds, monitoring', ['NURS-HOME']],
  ['GDA / attendant', 'Hygiene, turning, feeding help, mobility', ['ATTEND-12H']],
  ['Physiotherapist', 'Chest / limb; sessions a week ____', ['PHYSIO-HOME']],
  ['Other', 'Dietitian, speech and swallow therapist', []],
];
const HOME = [
  'Floor ____ · lift yes / no · society permission and service-lift timings for equipment delivery',
  'Lift car inside ____ × ____ cm, door ____ cm. A dismantled ICU bed needs about 210 cm of length; if it does not fit, check stair width and turns',
  'Doorways: building ____ cm, patient room ____ cm, bathroom ____ cm (bed about 90 to 100 cm wide, wheelchair about 70 cm)',
  'Room ____ × ____ m; about 1 m clear on both long sides and the foot of the bed for turning, suction and transfers',
  'Power: a dedicated, earthed 15 / 16 A socket within reach of the bed for each life-support device (ventilator, HF machine, concentrator); no shared extension boards',
  'Free sockets near the bed ____; voltage steady; power cuts a week ____; inverter / UPS ____ hours or generator',
  'Oxygen safety: no smoking, no open flame or gas stove in or next to the room; window or ventilation',
  'Space for the nurse or GDA to sit and rest; storage for consumables and cylinders; a handwashing point',
  'Bathroom usable with a commode or wheelchair; water supply',
  'Mobile signal in the room (alarm calls, video consults)',
  'Who is at home by day and by night; the family member to be trained on the equipment',
  'Infection risks at home: young children, pets, recent illness in the household',
];

// ---------- Part C: consultation script ----------
const SCRIPT = [
  ['Open', 'Thank you for meeting me. I have seen [patient], and spoken with Dr [name] and the ward nurse. I will take you through what the doctor wants in place at home, what each item costs for the plan period, and the choices you have. Nothing is final until you sign.'],
  ['Explain the clinical picture', 'In simple words: the condition, what support [patient] needs now (oxygen, feeding, turning), and what the doctor expects over the next weeks.'],
  ['Set the pricing frame', 'These prices come from the Hinduja Home Care rate card. Every family pays the same rates and I cannot change them here. If a discount applies, Hinduja management approves it and I will tell you.'],
  ['Must-have items first', 'These items are what Dr [name] needs in place for [patient] to be safe at home. Without them the doctor may not agree to discharge home, or [patient] may need to come back to hospital.'],
  ['Then optional items', 'These make care easier for you, but [patient] is safe without them. Many families start without them and add them later; we can add any item at the same rate.'],
  ['If cost is a concern', 'Offer in this order, and only what the doctor agrees to: 1. keep every must-have item and drop optional ones; 2. 12-hour instead of 24-hour cover where the doctor allows it, with a trained family member for the other shift; 3. a shorter first period with a review on day 15 for items that can be weaned; 4. a payment schedule (50% now and 50% in 15 days, or thirds every 10 days).'],
  ['If space is a concern', 'Use the measurements in Part B: a semi-Fowler bed instead of a motorised ICU bed where the doctor agrees; the HF machine already gives oxygen, so ask whether a separate concentrator is still needed; deliver equipment dismantled; plan the room layout with the family.'],
  ['If a must-have item is declined', 'I will respect your decision. I have to record that the family chose not to take [item] against medical advice, and Dr [name] and our medical desk will be told. Tick the box in Part D and record the reason on the case.'],
  ['Close', 'Read back the agreed items, the plan length, the start date and the total. Ask: is there anything you want to change before you sign? Then complete Part D.'],
];
const OBJECTIONS = [
  ['"It is too expensive."', 'Show the per-day figure, walk the must-have and optional columns again, offer the payment schedule. Never drop a must-have item to close.'],
  ['"We will arrange it ourselves."', 'Fine for optional items. For must-have items, ask what they will use and check it meets the doctor\'s settings; record it as dropped, reason "family will arrange".'],
  ['"Can we decide after discharge?"', 'Equipment and staff take up to 24 hours to deploy. Without sign-off nothing is sent, so the patient may go home before the setup is ready.'],
  ['"Our domestic help can do this."', 'A GDA can be replaced by a trained family member or helper. Skilled nursing tasks (suction, tracheostomy, injectables) cannot.'],
];

const PAY = ['Full advance', '50% now, 50% in 15 days', 'Every 10 days, in thirds'];
const MODES = ['In person', 'WhatsApp', 'Email', 'Recorded phone call'];

const Box = () => <span className="cl-box" aria-hidden="true" />;
const Ticks = ({ items, cols }) => (
  <ul className={`cl-ticks${cols ? ' two' : ''}`}>{items.map((t) => <li key={t}><Box /><span>{t}</span></li>)}</ul>
);
const Line = ({ label, value, wide }) => (
  <div className={`cl-line${wide ? ' wide' : ''}`}><span className="cl-lbl">{label}</span><span className="cl-fill">{value ?? ''}</span></div>
);
const Part = ({ n, title, sub, children, page }) => (
  <section className={`cl-part${page ? ' cl-page' : ''}`}>
    <h2><span className="mono">{n}</span> {title}</h2>
    {sub && <p className="cl-sub">{sub}</p>}
    {children}
  </section>
);

export default function Checklist() {
  const { can, profile } = useAuth();
  const [sp] = useSearchParams();
  const caseId = sp.get('case');
  const [days, setDays] = useState('');
  const d = Number(days) >= 1 && Number(days) <= 365 ? Math.round(Number(days)) : null;
  const allowed = can(...CHECKLIST_ROLES);
  const c = useLoad(() => (allowed && caseId ? q(db.from('v_cases').select('id,case_no,patient_name,patient_age,patient_gender,patient_locality,branch,hospital_name,hospital_ward,hospital_room,treating_doctor,expected_discharge_on,decision_maker_name,decision_maker_relation,decision_maker_mobile_display,coordinator_name,plan_days')
    .eq('id', caseId).maybeSingle()) : null), [caseId, allowed], ['cases']);
  const visit = useLoad(() => (allowed && caseId ? q(db.from('v_assessments').select('nurse_name,status,scheduled_at,visited_at,doctor_name')
    .eq('case_id', caseId).order('created_at', { ascending: false }).limit(1)) : []), [caseId, allowed], ['discharge_assessments']);
  const sheet = useLoad(() => (allowed ? rpc('care_plan_sheet', { p_case: caseId || null, p_days: d }) : null), [caseId, d, allowed], ['case_items', 'services', 'cases']);
  const [run, busy] = useAction();

  if (!allowed) return <div className="page"><Empty title="Not available for your role">The assessment checklist is used by care coordinators, nurses and the medical desk.</Empty></div>;
  const loading = c.loading || visit.loading || sheet.loading;
  const k = c.data;
  const v = (visit.data || [])[0];
  const s = sheet.data;
  const plan = s?.case;
  const planDays = s?.days || 30;
  const onCase = (codes) => (plan?.items || []).filter((i) => codes.includes(i.code));
  const caseQty = (codes) => onCase(codes).map((i) => `${num(i.qty)} ${i.unit || ''}${i.excluded ? ' (dropped)' : ''}`).join(', ');
  const agreed = (plan?.items || []).filter((i) => !i.excluded);
  const dropped = (plan?.items || []).filter((i) => i.excluded);
  const unpriced = (s?.options || []).some((o) => !o.priced) || (plan?.items || []).some((i) => !i.priced);

  const print = () => run(async () => {
    if (caseId) await rpc('log_access', { p_action: 'export', p_entity: 'case', p_entity_id: caseId, p_meta: { what: 'assessment_checklist', days: planDays } });
    setTimeout(() => window.print(), 50);
  });

  return (
    <div className="page">
      <div className="no-print">
        <PageHead title="Assessment & closure checklist" sub="Print before the Hinduja visit; fill at the bedside and with the family. Enter the result on the case the same day.">
          <div className="row gap-8 wrap">
            {caseId ? <><Link className="btn" to={`/cases/${caseId}`}>Back to case</Link><Link className="btn" to="/checklist">Blank form</Link></> : null}
            <Button kind="primary" icon="print" disabled={busy || loading} onClick={print}>Print</Button>
          </div>
        </PageHead>
        <div className="row gap-12 wrap mb-12" style={{ alignItems: 'flex-end' }}>
          <Field label="Plan length (days)" hint={`prices below are for ${planDays} days`}>
            <Input type="number" min="1" max="365" style={{ width: 110 }} value={days} placeholder={String(k?.plan_days || 30)} onChange={(e) => setDays(e.target.value)} />
          </Field>
          {caseId && !loading && !k && <ErrorNote error="This case is not visible to you, so the form prints blank." />}
          <ErrorNote error={sheet.error} />
        </div>
      </div>

      {loading ? <Skeleton lines={12} /> : (
        <article className="cl">
          <header className="cl-head">
            <div>
              <div className="cl-org">Hinduja Home Care Services · operated by SecondMedic</div>
              <h1>Clinical assessment & commercial closure checklist</h1>
              <div className="cl-sub">Post-discharge home care transition · hospital care coordinator · {FORM}</div>
            </div>
            <div className="cl-caseno"><span className="cl-lbl">Case ID</span><span className="mono">{k?.case_no || ''}</span></div>
          </header>

          <div className="cl-grid">
            <Line label="Patient" value={k?.patient_name} />
            <Line label="Age / sex" value={k ? [k.patient_age, k.patient_gender].filter(Boolean).join(' / ') : ''} />
            <Line label="UHID" />
            <Line label="Hospital" value={k?.hospital_name || 'P. D. Hinduja Hospital'} />
            <Line label="Ward / room / bed" value={k ? [k.hospital_ward, k.hospital_room].filter(Boolean).join(', ') : ''} />
            <Line label="Treating doctor" value={v?.doctor_name || k?.treating_doctor} />
            <Line label="Expected discharge" value={k?.expected_discharge_on ? dateLong(k.expected_discharge_on) : ''} />
            <Line label="Decision-maker" value={k ? [k.decision_maker_name, k.decision_maker_relation].filter(Boolean).join(', ') : ''} />
            <Line label="Decision-maker mobile" value={k?.decision_maker_mobile_display} />
            <Line label="Care coordinator" value={v?.nurse_name || (profile?.role === 'field_staff' || profile?.role === 'coordinator' ? profile.full_name : '')} />
            <Line label="Visit date / time" value={v?.status === 'scheduled' ? dateTime(v.scheduled_at) : ''} />
            <Line label="Home locality / branch" value={k ? [k.patient_locality, k.branch].filter(Boolean).join(' · ') : ''} />
          </div>

          <Part n="A" title="Pre-assessment" sub="Tick when done. Write what you find; the case record is filled from this.">
            <h3>A1 · Patient file check</h3>
            <Ticks items={FILE_CHECK} cols />
            <Line label="Diagnosis" wide /><Line label="Current support" wide />
            <h3>A2 · Treating doctor: points to discuss</h3>
            <Ticks items={DOCTOR_POINTS} cols />
            <Line label="Doctor's recommendations (as stated)" wide /><Line label="" wide /><Line label="" wide />
            <div className="cl-grid three"><Line label="Doctor's name" value={v?.doctor_name || k?.treating_doctor} /><Line label="Met at (time)" /><Line label="Discharge ready: yes / no / deferred to" /></div>
            <h3>A3 · Primary nurse handover</h3>
            <Ticks items={HANDOVER} cols />
            <div className="cl-grid three"><Line label="Ward nurse" /><Line label="Shift" /><Line label="Handover at (time)" /></div>
          </Part>

          <Part n="B" title="Home readiness evaluation" sub="Ask the family at the bedside; confirm by photo or a home visit before equipment is dispatched." page>
            <h3>B1 · Clinical equipment</h3>
            <div className="table-wrap"><table className="cl-t">
              <thead><tr><th>Item</th><th className="c">Needed<br />Y / N</th><th className="c">Must-have<br />M / O</th><th>Settings / specification to record</th><th>On case list</th></tr></thead>
              <tbody>{EQUIPMENT.map(([item, spec, codes]) => (
                <tr key={item}><td><strong>{item}</strong></td><td className="c"><Box /> <Box /></td><td className="c"><Box /> <Box /></td>
                  <td><div className="cl-hint">{spec}</div><div className="cl-write" /></td><td className="small">{caseQty(codes)}</td></tr>
              ))}</tbody>
            </table></div>

            <h3>B2 · Manpower shifts</h3>
            <div className="table-wrap"><table className="cl-t">
              <thead><tr><th>Role</th><th className="c">Not<br />needed</th><th className="c">12 h<br />day</th><th className="c">12 h<br />night</th><th className="c">24 h<br />(2 × 12 h)</th><th className="c">M / O</th><th>Start date</th><th>On case list</th></tr></thead>
              <tbody>{MANPOWER.map(([role, scope, codes]) => (
                <tr key={role}><td><strong>{role}</strong><div className="cl-hint">{scope}</div></td>
                  <td className="c"><Box /></td><td className="c"><Box /></td><td className="c"><Box /></td><td className="c"><Box /></td><td className="c"><Box /> <Box /></td>
                  <td><div className="cl-write" /></td><td className="small">{caseQty(codes)}</td></tr>
              ))}</tbody>
            </table></div>
            <p className="cl-note">Guide only; the treating doctor decides. A ventilator, a fresh tracheostomy or suction more often than every 2 hours usually needs ICU-trained nursing round the clock. HF oxygen usually needs 24-hour nursing until weaning starts. A stable bedbound patient is usually safe with a 12-hour nurse and a GDA. Record the doctor's decision in the M / O column, not the family's preference.</p>

            <h3>B3 · Home environment</h3>
            <Ticks items={HOME} />
            <Line label="Home setup notes (for the case)" wide /><Line label="" wide />
          </Part>

          <Part n="C" title={`Commercial consultation · ${planDays}-day plan`} sub="Meet the decision-maker after the doctor and the ward nurse. Show this page; prices are the approved rate card." page>
            <h3>C1 · Consultation script</h3>
            <ol className="cl-script">{SCRIPT.map(([t, say]) => <li key={t}><strong>{t}.</strong> <span>{say}</span></li>)}</ol>
            <div className="table-wrap"><table className="cl-t">
              <thead><tr><th>If the family says</th><th>Respond</th></tr></thead>
              <tbody>{OBJECTIONS.map(([a, b]) => <tr key={a}><td><strong>{a}</strong></td><td>{b}</td></tr>)}</tbody>
            </table></div>

            <h3>C2 · This patient's plan{plan ? '' : ' (write in the recommended items)'}</h3>
            <div className="table-wrap"><table className="cl-t">
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Rate</th><th className="num">{planDays}-day price</th><th className="c">M / O</th><th className="c">Keep / drop</th><th>Reason if dropped</th></tr></thead>
              <tbody>
                {(plan?.items || []).map((i) => (
                  <tr key={i.code + i.qty + i.excluded} className={i.excluded ? 'cl-dropped' : ''}>
                    <td><span className="cl-name">{i.name}</span>{i.recommended ? '' : <span className="cl-hint"> · added on quote</span>}</td>
                    <td className="num">{num(i.qty)} {i.unit || ''}</td>
                    <td className="num">{i.priced ? inr(i.unit_price) : 'Not priced'}</td>
                    <td className="num">{i.priced ? inr(i.line_total) : '–'}</td>
                    <td className="c"><Box /> <Box /></td>
                    <td className="c">{i.excluded ? 'Dropped' : <><Box /> <Box /></>}</td>
                    <td className="small">{i.exclude_reason || ''}</td>
                  </tr>
                ))}
                {Array.from({ length: plan?.items?.length ? 3 : 10 }, (_, n) => (
                  <tr key={`blank${n}`} className="cl-blank"><td /><td /><td /><td /><td className="c"><Box /> <Box /></td><td className="c"><Box /> <Box /></td><td /></tr>
                ))}
              </tbody>
            </table></div>

            <div className="table-wrap"><table className="cl-t cl-sum">
              <thead><tr><th>Option</th><th>What it includes</th><th className="num">{planDays}-day total</th><th className="c">Family's choice</th></tr></thead>
              <tbody>
                <tr><td><strong>A · Full recommendation</strong></td><td>Everything the doctor and the coordinator recommended</td><td className="num">{Number(plan?.recommended_total) > 0 ? inr(plan.recommended_total) : ''}</td><td className="c"><Box /></td></tr>
                <tr><td><strong>B · Must-have only</strong></td><td>Only items marked M; optional items can be added later at the same rate</td><td className="num" /><td className="c"><Box /></td></tr>
                <tr><td><strong>C · Agreed plan</strong></td><td>As listed in Part D{plan && Number(plan.discount_amount) > 0 ? ` · discount ${Number(plan.discount_pct)}% (${inr(plan.discount_amount)})` : ''}</td>
                  <td className="num">{plan ? inr(plan.total) : ''}{plan?.per_day ? <div className="cl-hint">{inr(plan.per_day)} a day</div> : null}</td><td className="c"><Box /></td></tr>
              </tbody>
            </table></div>

            <h3>C3 · Rate card: {planDays}-day prices</h3>
            <div className="table-wrap"><table className="cl-t">
              <thead><tr><th>Item</th><th>Basis</th><th className="num">Rate</th><th className="num">Qty</th><th className="num">{planDays}-day price</th></tr></thead>
              <tbody>{(s?.options || []).map((o) => (
                <tr key={o.code + (o.cover || '')}>
                  <td>{o.name}{o.cover ? <strong> · {o.cover} cover</strong> : null}</td>
                  <td className="small">{o.basis}</td>
                  <td className="num">{o.priced ? `${inr(o.unit_price)} / ${o.unit}` : 'Not priced'}</td>
                  <td className="num">{o.qty == null ? '–' : num(o.qty)}</td>
                  <td className="num">{o.plan_total == null ? '–' : inr(o.plan_total)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            {unpriced && <p className="cl-note">"Not priced" items are waiting for Hinduja management to approve a rate. Do not quote a figure for them; the quote and sign-off stay blocked until the rate is approved.</p>}
            <p className="cl-note">Diagnostics (sample collection, portable X-ray, ECG) are priced per test on the quote and done by SecondMedic. Medicines and consumables are not included unless listed.</p>
          </Part>

          <Part n="D" title="Sign-off & consent" page>
            <h3>D1 · Scope confirmation</h3>
            <p>I confirm the agreed home care plan below for <span className="cl-in">{plan ? planDays : ''}</span> days, starting <span className="cl-in" />, at a total of <span className="cl-in">{plan ? inr(plan.total) : ''}</span> at Hinduja Home Care rate-card prices{plan && Number(plan.discount_amount) > 0 ? `, after a discount of ${inr(plan.discount_amount)}` : ''}.</p>
            <ol className="cl-agreed">
              {agreed.map((i) => <li key={i.code + i.qty}>{i.name} · {num(i.qty)} {i.unit || ''}</li>)}
              {Array.from({ length: agreed.length ? 2 : 8 }, (_, n) => <li key={`a${n}`} className="cl-blank-li" />)}
            </ol>
            <div className="cl-opts"><span className="cl-lbl">Payment</span>{PAY.map((p) => <span key={p}><Box /> {p}</span>)}</div>

            <h3>D2 · Items not included</h3>
            <p>These items were recommended but are not part of this plan at the family's request. The reasons for the recommendation were explained to me.</p>
            <ol className="cl-agreed">
              {dropped.map((i) => <li key={i.code + i.qty}>{i.name}{i.exclude_reason ? ` · reason: ${i.exclude_reason}` : ''}</li>)}
              {Array.from({ length: dropped.length ? 1 : 4 }, (_, n) => <li key={`d${n}`} className="cl-blank-li" />)}
            </ol>
            <ul className="cl-terms">
              <li>Hinduja Home Care Services and its partners are not responsible for any part of care that depends on an item not included above. Any item can be added later at rate-card prices.</li>
              <li>Not covered by this plan: emergency transfers (call 108 or use the Hinduja emergency number), hospital bills, insurance claims, medicines and consumables, doctor home visits and tests unless listed above.</li>
              <li>A change of scope after signing changes the total and needs a fresh sign-off.</li>
            </ul>
            <div className="cl-ama"><Box /><span><strong>Against medical advice.</strong> I have chosen not to take the following must-have item(s) although the treating doctor recommended them, and I understand the risks explained to me: <span className="cl-in wide" /></span></div>

            <h3>D3 · Consent</h3>
            <ul className="cl-ticks">
              <li><Box /><span>I agree that Hinduja Home Care Services shares the patient's name, address, contact number, discharge details and the agreed items with its service partners (Book My Medicare for staff and equipment, SecondMedic for diagnostics) only to deliver this plan. Call recordings and the clinical assessment are not shared with partners.</span></li>
              <li><Box /><span>I have been told how the patient's personal data is handled under the Digital Personal Data Protection Act, 2023 (<a href="/privacy">Privacy notice</a> and <a href="/terms">Terms</a> at {window.location.host}/privacy and /terms).</span></li>
            </ul>
            <div className="cl-opts"><span className="cl-lbl">Signed off</span>{MODES.map((m) => <span key={m}><Box /> {m}</span>)}</div>

            <div className="cl-sign">
              <div><div className="cl-sigbox" /><Line label="Family decision-maker" value={k?.decision_maker_name} /><Line label="Relation · mobile" value={k ? [k.decision_maker_relation, k.decision_maker_mobile_display].filter(Boolean).join(' · ') : ''} /><Line label="Date and time" /></div>
              <div><div className="cl-sigbox" /><Line label="Patient, if able (signature or thumb impression)" /><Line label="Date and time" /></div>
              <div><div className="cl-sigbox" /><Line label="Care coordinator" value={v?.nurse_name} /><Line label="Employee code" /><Line label="Date and time" /></div>
              <div><div className="cl-sigbox" /><Line label="Witness (optional)" /><Line label="Date and time" /></div>
            </div>

            <div className="cl-office">
              <span className="cl-lbl">Office use</span> Entered on the CareDesk case by <span className="cl-in" /> on <span className="cl-in" />:
              <Box /> validation visit <Box /> item list <Box /> drops with reasons <Box /> quote sent <Box /> sign-off recorded
            </div>
          </Part>
          <footer className="cl-foot">{FORM}{k?.case_no ? ` · ${k.case_no}` : ''} · Confidential: patient data under the DPDP Act 2023. Do not photograph or share outside the care team; hand the signed form to the coordinator desk.</footer>
        </article>
      )}
    </div>
  );
}
