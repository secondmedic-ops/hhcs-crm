// DEMO-mode stand-ins for the Worker endpoints (telephony, messaging, AI).
// Database effects go through the real SQL functions, so stage gates, SLAs and audit still apply.
import { db, demoSession, rpc } from '../lib/db.js';

const svc = (sql, params) => db.service(sql, params);
const one = async (sql, params) => (await svc(sql, params))[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = () => demoSession.userId();

async function me() { return one('select * from profiles where id = $1', [uid()]); }

// ---------- telephony
export async function simulateInboundCall(script) {
  const agent = await me();
  const known = Math.random() < 0.5 && !script;
  const p = known ? await one(`select id, mobile from patients order by random() limit 1`) : null;
  const number = p?.mobile || '+9198' + String(Math.floor(20000000 + Math.random() * 79999999));
  const openCase = p ? await one(`select id from cases where patient_id = $1 and stage not in ('closed','cancelled') order by created_at desc limit 1`, [p.id]) : null;
  const c = await one(`insert into calls (workspace_id, provider, session_id, direction, customer_number, did_number, agent_id, agent_name, status, patient_id, case_id, started_at, raw)
    values ($1,'myoperator',$2,'inbound',$3,$9,$4,$5,'ringing',$6,$7, now(), $8) returning *`,
    [agent.workspace_id, 'demo-' + crypto.randomUUID().slice(0, 13), number, agent.role === 'agent' ? agent.id : null, agent.full_name, p?.id || null, openCase?.id || null,
      JSON.stringify({ demo_script: script || null }), '+918049368621']);
  return c;
}

export async function answerCall(callId) {
  await svc(`update calls set status = 'answered', answered_at = now(), ring_seconds = greatest(1, extract(epoch from now() - started_at)::int) where id = $1`, [callId]);
  await svc(`select callback_connected($1::uuid)`, [callId]);   // the callback this call dials is reached
}

const DEMO_SCRIPT = {
  text: 'My father is 72 and needs blood tests and an ECG at home in Andheri tomorrow morning.',
  extracted: { patient_name: 'Mr. Raghunath Sharma', age: 72, gender: 'M', caller_name: 'Amit Sharma', caller_relation: 'son',
    locality: 'Andheri West', pincode: '400058', address: '14, Sai Krupa CHS, Link Road', landmark: 'Near Shoppers Stop', service_codes: ['LAB-PANEL', 'ECG-12'], preferred: 'tomorrow 08:00', urgent: false },
};

export async function endCall(callId) {
  const c = await one(`update calls set status = case when status = 'ringing' then (case when direction = 'inbound' then 'missed' else 'failed' end) else 'completed' end,
    ended_at = now(), talk_seconds = case when answered_at is null then 0 else greatest(5, extract(epoch from now() - answered_at)::int) end,
    recording_filename = case when answered_at is null then null else 'demo-recording.mp3' end where id = $1 returning *`, [callId]);
  if (c.status === 'missed') {
    await svc(`insert into callbacks (workspace_id, call_id, number, patient_id, reason, due_at) values ($1,$2,$3,$4,'missed', now() + interval '10 minutes')`,
      [c.workspace_id, c.id, c.customer_number, c.patient_id]);
  }
  if (c.patient_id || c.case_id) {
    await svc(`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, evidence, call_id, occurred_at)
      values ($1,$2,$3,'phone',$4,$5,$6,$7,$8,$9,$10)`, [c.workspace_id, c.case_id, c.patient_id, c.direction, c.agent_id, c.agent_name || 'Telephony',
      `${c.direction === 'inbound' ? 'Inbound' : 'Outbound'} call ${c.status}${c.ring_seconds != null && c.status === 'completed' ? ` · answered in ${c.ring_seconds} s` : ''}`,
      c.recording_filename ? `Recording ${Math.floor(c.talk_seconds / 60)}:${String(c.talk_seconds % 60).padStart(2, '0')}` : null, c.id, c.started_at]);
  }
  if (c.status === 'completed') setTimeout(() => processCall(callId).catch(() => {}), 1600);
  if (c.direction === 'outbound' && c.callback_id) await svc(`select callback_call_ended($1::uuid)`, [c.id]);
  return c;
}

const WA_SAMPLES = [
  { name: 'Mrs. Kavita Deshmukh', text: 'Namaste, need home blood sample collection (CBC, HbA1c, Thyroid) and ECG for my mother (74 yrs) in Khar West tomorrow 8 AM. Pincode 400052.' },
  { name: 'Mr. Harish Kulkarni', text: 'Hello Hinduja Home Care, can you send a physiotherapist at home in Dadar West (400028) for post-knee surgery rehab?' },
  { name: 'Mrs. Sunita Joshi', text: 'Please share the rate card for portable X-Ray chest at home in Bandra West. My father cannot travel.' },
];

export async function simulateInboundWhatsApp(customText) {
  const agent = await me();
  const sample = WA_SAMPLES[Math.floor(Math.random() * WA_SAMPLES.length)];
  const existing = !customText && Math.random() < 0.45
    ? await one(`select c.id as case_id, c.patient_id, p.full_name from cases c join patients p on p.id = c.patient_id
        where c.workspace_id = $1 and c.stage not in ('closed','cancelled') order by c.created_at desc limit 1`, [agent.workspace_id])
    : null;
  if (existing) {
    const body = customText || 'We have shared the address: 402 Sea Breeze, Linking Road, Khar West 400052. Please confirm the morning 8:30 AM slot.';
    const row = await one(`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_label, summary, body, evidence, meta)
      values ($1,$2,$3,'whatsapp','inbound','Patient','WhatsApp message received',$4,'Message copy','{"delivery_status":"received"}'::jsonb) returning *`,
      [agent.workspace_id, existing.case_id, existing.patient_id, body]);
    return { ...row, patient_id: existing.patient_id, case_id: existing.case_id, patient_name: existing.full_name };
  }
  const number = '+9198' + String(Math.floor(20000000 + Math.random() * 79999999));
  const text = customText || sample.text;
  const r = (await one(`select create_enquiry($1::jsonb) as r`, [JSON.stringify({
    workspace_id: agent.workspace_id,
    source_channel: 'whatsapp',
    services_requested: text.slice(0, 500),
    patient: { full_name: sample.name, mobile: number },
    caller_mobile: number,
    owner_id: agent.role === 'agent' ? agent.id : null,
  })])).r;
  const row = await one(`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_label, summary, body, evidence, meta)
    values ($1,$2,$3,'whatsapp','inbound','Patient','WhatsApp message received',$4,'Message copy','{"delivery_status":"received"}'::jsonb) returning *`,
    [agent.workspace_id, r.case_id, r.patient_id, text]);
  return { ...row, patient_id: r.patient_id, case_id: r.case_id, case_no: r.case_no, patient_name: sample.name };
}

async function processCall(callId) {
  const c = await one('select * from calls where id = $1', [callId]);
  const scripted = c.raw?.demo_script || !c.patient_id;
  const services = await svc(`select id, code, name from services`);
  const ex = scripted ? DEMO_SCRIPT.extracted : null;
  const p = c.patient_id ? await one('select * from patients where id = $1', [c.patient_id]) : null;
  const summary = scripted
    ? 'Son called for his 72-year-old father: blood tests and an ECG at home in Andheri West tomorrow morning. Consent given; address and landmark read back. No red-flag symptoms.'
    : `${c.direction === 'inbound' ? 'Caller' : 'Agent called'} ${p?.full_name || 'the patient'} about ${c.case_id ? 'an open case' : 'a general query'}; details confirmed and next step agreed.`;
  await svc(`update calls set ai_summary = $2, ai_sentiment = 'neutral', ai_intent = $3, ai_extracted = $4, ai_flags = $5, ai_processed_at = now(),
    ai_status = 'done', ai_error = null, transcript = $6 where id = $1`, [callId, summary, scripted ? 'new_booking' : 'other',
    JSON.stringify(ex ? { ...ex, consent_given: true, language: 'Hindi + English', service_ids: ex.service_codes.map((k) => services.find((s) => s.code === k)?.id) } : { consent_given: true }),
    '{}', scripted ? `Agent: Good evening, thank you for calling Hinduja Home Care. This is Priya.\nCaller: Hi, my father is 72 and needs blood tests and an ECG at home in Andheri tomorrow morning.\nAgent: Certainly. This call is recorded for quality and your records, may we record and use these details to arrange the service?\nCaller: Yes, that's fine.\nAgent: May I have your father's name and the full address with a landmark and pincode?\nCaller: Raghunath Sharma, 14 Sai Krupa CHS, Link Road, near Shoppers Stop, Andheri West, 400058.\nAgent: Thank you. Is he having any chest pain or breathlessness right now?\nCaller: No, this is a routine check.\nAgent: I'll share the quote on WhatsApp shortly with your reference number.` : null]);
  const g = () => 3 + Math.round(Math.random() * 2);
  const s = { greeting: g(), consent: 5, price_accuracy: g(), empathy: g(), closure: g() };
  await svc(`insert into qa_reviews (workspace_id, call_id, agent_id, greeting, consent, price_accuracy, empathy, closure, total_pct, notes, ai_generated)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`, [c.workspace_id, callId, c.agent_id, s.greeting, s.consent, s.price_accuracy, s.empathy, s.closure,
    Math.round(((s.greeting + s.consent + s.price_accuracy + s.empathy + s.closure) / 25) * 1000) / 10, 'Consent taken clearly. Read back the case reference before closing.']);
  return { summary };
}

// ---------- AI stand-ins
function briefFor(c, gates) {
  const missing = (gates.checks || []).filter((x) => !x.ok).map((x) => x.label);
  const nextMap = {
    enquiry: 'Complete the enquiry details and move to Pricing.', pricing: 'Send the quote on template T-03.',
    booking: 'Confirm the slot and send the booking confirmation.', deployment: 'Track the technician to a geo-tagged check-in.',
    completion: 'Close the visit with patient sign-off and barcoded samples.', payment: 'Collect the balance and reconcile against the gateway.',
    closure: 'Deliver the report, capture feedback and close.',
  };
  const risk = c.sla_state === 'breached' || c.open_escalations > 0 ? 'high' : c.sla_state === 'at_risk' || c.open_complaints > 0 ? 'medium' : 'low';
  return {
    summary: `${c.patient_name} (${c.patient_age || '?'}${c.patient_gender || ''}, ${c.patient_locality || c.zone_name || ''}), ${c.service_names || c.services_requested || 'services pending'}. Case is at ${c.stage}; total ₹${c.total}, collected ₹${c.amount_collected}.`,
    next_action: missing.length ? `${nextMap[c.stage] || 'Review the case.'} Still missing: ${missing.join(', ')}.` : (nextMap[c.stage] || 'No action pending.'),
    owner: { enquiry: 'agent', pricing: 'agent', booking: 'coordinator', deployment: 'field', completion: 'field', payment: 'coordinator', closure: 'agent' }[c.stage] || 'supervisor',
    risk, risk_reason: risk === 'high' ? (c.sla_state === 'breached' ? 'An SLA has been breached' : 'Open escalation') : risk === 'medium' ? 'SLA window more than 75% used' : 'On track',
    patient_message_hint: { pricing: 'T-03 Quote', booking: 'T-04 Booking confirmation', deployment: 'T-05 Technician ETA', closure: 'T-07 Report ready' }[c.stage] || null,
    generated_at: new Date().toISOString(), demo: true,
  };
}

const STAGE_WORDS = ['enquiry', 'pricing', 'booking', 'deployment', 'completion', 'payment', 'closure', 'closed', 'cancelled'];
const ROUTES = [[/whatsapp|chat/, '/whatsapp'], [/callback|missed/, '/callbacks'], [/approv|discount/, '/approvals'], [/escalat/, '/escalations'], [/complain/, '/complaints'],
  [/mis|report|weekly|monthly/, '/mis'], [/audit|log/, '/audit'], [/dispatch|field|technician/, '/field'], [/call|recording/, '/calls'],
  [/patient/, '/patients'], [/setting|rate card|template/, '/settings'], [/dashboard|kpi/, '/']];

function parseCommand(q) {
  const s = q.toLowerCase();
  if (/new (enquiry|case|booking)|create (a )?case/.test(s)) return { action: 'new_enquiry', route: '/console', explain: 'Open a new enquiry' };
  const filters = {};
  const st = STAGE_WORDS.filter((w) => s.includes(w));
  if (st.length) filters.stage = st;
  if (/urgent/.test(s)) filters.priority = 'urgent';
  if (/breach|delayed|late|overdue/.test(s)) filters.sla_state = 'breached';
  else if (/at risk|risk/.test(s)) filters.sla_state = 'at_risk';
  for (const z of ['andheri', 'bandra', 'khar', 'dadar', 'mahim', 'powai', 'thane']) if (s.includes(z)) filters.zone = z;
  if (/whatsapp/.test(s) && /case|enquir/.test(s)) filters.channel = 'whatsapp';
  const d = (o) => new Date(Date.now() + 5.5 * 3600e3 + o * 86400e3).toISOString().slice(0, 10);
  if (/today/.test(s)) { filters.from = d(0); filters.to = d(0); }
  if (/yesterday/.test(s)) { filters.from = d(-1); filters.to = d(-1); }
  if (/this week|last 7/.test(s)) { filters.from = d(-6); filters.to = d(0); }
  if (Object.keys(filters).length && !/^(go|open|show) (to )?(the )?(mis|audit|settings|whatsapp)/.test(s)) {
    return { action: 'filter_cases', route: '/cases', filters, explain: 'Cases · ' + Object.entries(filters).map(([k, v]) => `${k}: ${[].concat(v).join('/')}`).join(' · ') };
  }
  for (const [re, route] of ROUTES) if (re.test(s)) return { action: 'navigate', route, explain: 'Open ' + route };
  return { action: 'search', route: '/cases', filters: { text: q }, explain: `Search cases for "${q}"` };
}

async function extract(text) {
  const s = text.toLowerCase();
  const services = await svc(`select id, code, name from services`);
  const codes = [];
  if (/blood|test|panel|sugar|thyroid|cbc|lft|kft/.test(s)) codes.push(/full|panel|senior|all/.test(s) || /blood tests/.test(s) ? 'LAB-PANEL' : 'LAB-CBC');
  if (/ecg|ekg|heart/.test(s)) codes.push('ECG-12');
  if (/x-?ray/.test(s)) codes.push(/leg|knee|hand|limb|joint/.test(s) ? 'XR-LIMB' : 'XR-CHEST');
  const loc = { 'andheri': ['Andheri West', '400058'], 'bandra': ['Bandra West', '400050'], 'khar': ['Khar West', '400052'], 'dadar': ['Dadar West', '400028'],
    'mahim': ['Mahim', '400016'], 'powai': ['Hiranandani Gardens', '400076'], 'thane': ['Thane West', '400601'] };
  const key = Object.keys(loc).find((k) => s.includes(k));
  const age = s.match(/(\d{2})\s*(years|yrs|yr|year|y\/o)?/);
  const rel = ['father', 'mother', 'husband', 'wife', 'son', 'daughter'].find((r) => s.includes('my ' + r));
  const relMap = { father: 'son', mother: 'son', husband: 'wife', wife: 'husband', son: 'parent', daughter: 'parent' };
  const tomorrow = /tomorrow/.test(s);
  const hour = /morning/.test(s) ? 8 : /afternoon/.test(s) ? 14 : /evening/.test(s) ? 17 : 10;
  const day = new Date(Date.now() + 5.5 * 3600e3 + (tomorrow ? 86400e3 : 0)).toISOString().slice(0, 10);
  const pin = s.match(/\b4\d{5}\b/)?.[0];
  const mob = s.match(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/)?.[0];
  return {
    patient: { full_name: null, age: age ? Number(age[1]) : null, gender: rel === 'father' || rel === 'husband' ? 'M' : rel === 'mother' || rel === 'wife' ? 'F' : null,
      mobile: mob || null, address: null, locality: key ? loc[key][0] : null, pincode: pin || (key ? loc[key][1] : null), landmark: null },
    caller_name: null, caller_relation: rel ? relMap[rel] : null, service_codes: codes,
    service_ids: codes.map((c) => services.find((x) => x.code === c)?.id).filter(Boolean),
    preferred_slot_iso: /tomorrow|today|morning|evening|afternoon/.test(s) ? `${day}T${String(hour).padStart(2, '0')}:00:00+05:30` : null,
    priority: /urgent|immediately|asap|right now|today itself/.test(s) ? 'urgent' : 'routine',
    clinical_red_flag: /chest pain|breathless|unconscious|collapse|bleeding/.test(s) ? 'Possible emergency described, follow script S-09' : null,
    missing: ['patient name', 'full address with landmark', !mob && 'mobile'].filter(Boolean), demo: true,
  };
}

const WEBHOOK_SAMPLE = (n) => ({
  event_id: 'evt_demo_' + n, source: 'myoperator', event_type: ['call.initiated', 'call.answered', 'call.end', 'call.summary'][n % 4], received_at: new Date(Date.now() - n * 47000).toISOString(),
  processed: true, error: null,
  payload: { event_id: 'evt_demo_' + n, event_type: ['call.initiated', 'call.answered', 'call.end', 'call.summary'][n % 4], event_sequence: n % 4 + 1, session_id: 'sess_demo_' + Math.floor(n / 4),
    direction: 'inbound', customer_identifier: '+9198200XXXXX', system_identifier: '+918049368621', timestamp: Math.floor(Date.now() / 1000) - n * 47,
    payload: n % 4 === 2 ? { id: 'call_' + n, status: 'answered', duration: 271, recording_filename: 'rec_' + n + '.mp3', legs: [{ dial_status: 'answered', ring_duration: 14, talk_duration: 257, agent: { uuid: '5001', name: 'Priya Nair' } }] } : {} },
});

// ---------- router
// demo WhatsApp session: kept across calls so "Scan QR" moves to connected
const DEMO_QR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 250 250" width="220" height="220">
  <rect width="250" height="250" fill="#ffffff"/>
  <rect x="20" y="20" width="50" height="50" fill="#111827"/>
  <rect x="28" y="28" width="34" height="34" fill="#ffffff"/>
  <rect x="36" y="36" width="18" height="18" fill="#111827"/>
  <rect x="180" y="20" width="50" height="50" fill="#111827"/>
  <rect x="188" y="28" width="34" height="34" fill="#ffffff"/>
  <rect x="196" y="36" width="18" height="18" fill="#111827"/>
  <rect x="20" y="180" width="50" height="50" fill="#111827"/>
  <rect x="28" y="188" width="34" height="34" fill="#ffffff"/>
  <rect x="36" y="196" width="18" height="18" fill="#111827"/>
  <rect x="176" y="176" width="36" height="36" fill="#111827"/>
  <rect x="184" y="184" width="20" height="20" fill="#ffffff"/>
  <rect x="190" y="190" width="8" height="8" fill="#111827"/>
  <path d="M78 30 h10 v8 h-10z M96 30 h8 v8 h-8z M112 30 h8 v8 h-8z M128 30 h14 v8 h-14z M150 30 h8 v8 h-8z M166 30 h6 v8 h-6z M78 46 h8 v8 h-8z M102 46 h14 v8 h-14z M124 46 h8 v8 h-8z M140 46 h18 v8 h-18z M166 46 h6 v8 h-6z M30 78 v10 h8 v-10z M46 78 v8 h8 v-8z M62 78 v16 h8 v-16z M86 78 h8 v8 h-8z M102 78 h14 v8 h-14z M124 78 h24 v8 h-24z M156 78 h14 v8 h-14z M178 78 h14 v8 h-14z M200 78 h10 v8 h-10z M30 96 v8 h8 v-8z M46 102 v12 h8 v-12z M62 102 v8 h8 v-8z M78 94 h8 v16 h-8z M94 94 h16 v8 h-16z M118 94 h14 v8 h-14z M140 94 h8 v16 h-8z M156 94 h16 v8 h-16z M180 94 h8 v16 h-8z M196 94 h14 v8 h-14z M30 120 v8 h8 v-8z M46 122 v8 h8 v-8z M78 118 h16 v8 h-16z M102 118 h8 v8 h-8z M118 118 h14 v8 h-14z M140 118 h16 v8 h-16z M164 118 h8 v8 h-8z M180 118 h14 v8 h-14z M202 118 h8 v8 h-8z M30 136 v14 h8 v-14z M54 136 h8 v14 h-8z M70 136 h8 v8 h-8z M86 136 h16 v8 h-16z M110 136 h8 v8 h-8z M126 136 h16 v8 h-16z M150 136 h8 v14 h-8z M166 136 h16 v8 h-16z M190 136 h18 v8 h-18z M30 158 v14 h8 v-14z M46 158 v8 h8 v-8z M62 158 v14 h8 v-14z M78 152 h14 v8 h-14z M100 152 h8 v14 h-8z M116 152 h16 v8 h-16z M140 152 h10 v8 h-10z M158 152 h8 v14 h-8z M174 152 h16 v8 h-16z M198 152 h12 v8 h-12z M78 174 h14 v8 h-14z M100 174 h8 v8 h-8z M116 174 h8 v8 h-8z M132 174 h16 v8 h-16z M156 174 h12 v8 h-12z M78 190 h8 v8 h-8z M94 190 h14 v8 h-14z M116 190 h8 v8 h-8z M132 190 h8 v8 h-8z M148 190 h14 v8 h-14z M78 206 h16 v8 h-16z M102 206 h8 v8 h-8z M118 206 h14 v8 h-14z M140 206 h8 v8 h-8z M156 206 h16 v8 h-16z" fill="#111827"/>
</svg>`;

let demoWaState = {
  status: 'connected',
  connected: true,
  mode: 'qr',
  waba_configured: false,
  bridge_online: true,
  qr_svg: null,
  qr_updated_at: null,
  pairing_code: null,
  phone: '+918049368621',
  name: 'Hinduja Home Care (Demo)',
  connected_at: new Date().toISOString(),
  last_seen_at: new Date().toISOString(),
  error: null,
  demo: true,
};

export async function demoApi(path, body = {}, method) {
  await sleep(250 + Math.random() * 350);
  let m;
  if (path === '/health') return { ok: true, demo: true, supabase: 'demo', telephony: 'simulated', recordings: 'simulated', whatsapp: 'simulated', ai: 'simulated' };
  if (path === '/calls/dial') {
    const agent = await me();
    let number, patientId = body.patient_id || null, caseId = body.case_id || null;
    if (caseId) { const r = await one(`select c.patient_id, p.mobile from cases c join patients p on p.id = c.patient_id where c.id = $1`, [caseId]); patientId = r.patient_id; number = r.mobile; }
    else if (body.callback_id) { const r = await one(`update callbacks set status = 'in_progress', assigned_to = $2, last_attempt_at = now(), attempts = attempts + 1 where id = $1 returning number, patient_id`, [body.callback_id, agent.id]); number = r.number; patientId = r.patient_id; }
    else if (patientId) number = (await one('select mobile from patients where id = $1', [patientId])).mobile;
    const c = await one(`insert into calls (workspace_id, provider, session_id, direction, customer_number, agent_id, agent_name, status, patient_id, case_id, click_to_call_ref, callback_id)
      values ($1,'myoperator',$2,'outbound',$3,$4,$5,'ringing',$6,$7,$2,$8) returning id`, [agent.workspace_id, 'crm-' + crypto.randomUUID(), number, agent.id, agent.full_name, patientId, caseId, body.callback_id || null]);
    setTimeout(() => answerCall(c.id).catch(() => {}), 2600);
    return { ok: true, call_id: c.id, provider: { status: 'success', demo: true } };
  }
  if ((m = path.match(/^\/cases\/(.+)\/quote$/))) {
    const out = await rpc('send_quote', { p_case: m[1], p_template: body.template_id });
    return { ...out, delivery: { simulated: true, note: 'WhatsApp delivery is simulated in demo mode' } };
  }
  if ((m = path.match(/^\/cases\/(.+)\/message$/))) {
    const text = await rpc('render_template', { p_template: body.template_id, p_case: m[1] });
    const t = await one('select * from templates where id = $1', [body.template_id]);
    const c = await one('select workspace_id, patient_id from cases where id = $1', [m[1]]);
    const a = await me();
    await svc(`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body, evidence, template_id)
      values ($1,$2,$3,$4,'outbound',$5,$6,$7,$8,'Message copy',$9)`, [c.workspace_id, m[1], c.patient_id, t.kind, a.id, a.agent_code || a.full_name, `${t.title} sent (template ${t.code})`, text, t.id]);
    return { text, delivery: { simulated: true } };
  }
  if (path === '/whatsapp/session') {
    return { ...demoWaState, last_seen_at: new Date().toISOString() };
  }
  if (path === '/whatsapp/session/action') {
    const act = body?.action || 'start';
    if (act === 'logout' || act === 'disconnect') {
      demoWaState = { ...demoWaState, status: 'disconnected', connected: false, qr_svg: null, phone: null, name: null };
    } else if (act === 'start' || act === 'refresh_qr') {
      demoWaState = { ...demoWaState, status: 'qr_ready', connected: false, qr_svg: DEMO_QR_SVG, qr_updated_at: new Date().toISOString(), bridge_online: true };
      setTimeout(() => {
        if (demoWaState.status === 'qr_ready') {
          demoWaState = { ...demoWaState, status: 'connected', connected: true, qr_svg: null, phone: '+918049368621', name: 'Hinduja Home Care (Demo)', connected_at: new Date().toISOString() };
        }
      }, 7000);
    }
    return { ...demoWaState, last_seen_at: new Date().toISOString() };
  }
  if (path === '/whatsapp/send') {
    const a = await me();
    let caseId = body.case_id || null;
    let patientId = body.patient_id || null;
    if (caseId && !patientId) {
      const k = await one('select patient_id from cases where id = $1', [caseId]);
      patientId = k?.patient_id || null;
    } else if (patientId && !caseId) {
      const k = await one(`select id from cases where patient_id = $1 and stage not in ('closed','cancelled') order by created_at desc limit 1`, [patientId]);
      caseId = k?.id || null;
    } else if (!caseId && !patientId && body.mobile) {
      const pid = await rpc('upsert_patient', { p: { workspace_id: a.workspace_id, mobile: body.mobile, full_name: body.patient_name || body.mobile } });
      patientId = pid;
      const k = await one(`select id from cases where patient_id = $1 and stage not in ('closed','cancelled') order by created_at desc limit 1`, [patientId]);
      caseId = k?.id || null;
    }
    let text = String(body.text || '').trim();
    let t = null;
    if (body.template_id) {
      t = await one('select * from templates where id = $1', [body.template_id]);
      if (caseId) text = await rpc('render_template', { p_template: body.template_id, p_case: caseId });
      else text = t?.body || text;
    }
    const summary = t ? `${t.title} sent (template ${t.code})` : 'WhatsApp reply sent';
    const row = await one(`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body, evidence, template_id, meta)
      values ($1,$2,$3,'whatsapp','outbound',$4,$5,$6,$7,'Message copy',$8,'{"delivery_status":"sent"}'::jsonb) returning id, occurred_at`,
      [a.workspace_id, caseId, patientId, a.id, a.agent_code || a.full_name, summary, text, t?.id || null]);
    return { id: row.id, occurred_at: row.occurred_at, text, case_id: caseId, patient_id: patientId, delivery: { simulated: true } };
  }
  if ((m = path.match(/^\/ai\/cases\/(.+)\/brief$/))) {
    const { data: c } = await db.from('v_cases').select('*').eq('id', m[1]).single();
    const gates = await rpc('case_gates', { p_case: m[1] });
    const brief = briefFor(c, gates);
    await svc('update cases set ai_brief = $2 where id = $1', [m[1], JSON.stringify(brief)]);
    return brief;
  }
  if ((m = path.match(/^\/ai\/calls\/(.+)$/))) return processCall(m[1]);
  if (path === '/ai/command') return parseCommand(body.q || '');
  if (path === '/ai/extract-enquiry') return extract(body.text || '');
  if (path === '/admin/webhooks') return Array.from({ length: 12 }, (_, i) => WEBHOOK_SAMPLE(i));
  if (path === '/admin/users') {
    const a = await me();
    const id = crypto.randomUUID();
    return one(`insert into profiles (id, workspace_id, full_name, email, phone, role, agent_code, myoperator_user_id, myoperator_extension, skills, active)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true) returning *`, [id, a.workspace_id, body.full_name, body.email, body.phone || null, body.role, body.agent_code || null, body.myoperator_user_id || null,
      body.myoperator_extension || null, '{' + (body.skills || []).join(',') + '}']);
  }
  throw new Error('Not available in demo: ' + path);
}

// a short synthetic "recording" so the player works in demo
export function demoRecording() {
  const rate = 8000, secs = 6, n = rate * secs;
  const buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate, env = Math.max(0, Math.sin(Math.PI * ((t * 1.7) % 1))) * (Math.sin(t * 3.1) > -0.2 ? 1 : 0);
    v.setInt16(44 + i * 2, Math.round((Math.sin(2 * Math.PI * 180 * t) * 0.5 + Math.sin(2 * Math.PI * 260 * t) * 0.3 + (Math.random() - 0.5) * 0.15) * env * 5000), true);
  }
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
export { DEMO_SCRIPT };
