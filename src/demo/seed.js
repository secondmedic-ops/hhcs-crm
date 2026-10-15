// Generates a realistic week of Hinduja Home Care operations for DEMO mode.
// All people below are fictional. Inserted with triggers disabled so history keeps its timestamps.

export const DEMO_USERS = [
  { id: 'a0000000-0000-4000-8000-000000000001', full_name: 'Priya Nair', role: 'agent', agent_code: 'A-07', email: 'priya.agent@demo.local', myoperator_user_id: '5001' },
  { id: 'a0000000-0000-4000-8000-000000000002', full_name: 'Rohit Kale', role: 'agent', agent_code: 'A-08', email: 'rohit.agent@demo.local', myoperator_user_id: '5002' },
  { id: 'a0000000-0000-4000-8000-000000000003', full_name: 'Sneha Patil', role: 'agent', agent_code: 'A-11', email: 'sneha.agent@demo.local', myoperator_user_id: '5003' },
  { id: 'a0000000-0000-4000-8000-000000000004', full_name: 'Farhan Shaikh', role: 'coordinator', email: 'farhan.coord@demo.local' },
  { id: 'a0000000-0000-4000-8000-000000000005', full_name: 'Meera Iyer', role: 'supervisor', email: 'meera.sup@demo.local' },
  { id: 'a0000000-0000-4000-8000-000000000006', full_name: 'Dr. Anil Rao', role: 'medical_desk', email: 'anil.md@demo.local' },
  { id: 'a0000000-0000-4000-8000-000000000007', full_name: 'Santosh Jadhav', role: 'field_staff', skills: ['phlebotomy'], phone: '+919800000107' },
  { id: 'a0000000-0000-4000-8000-000000000008', full_name: 'Kavita More', role: 'field_staff', skills: ['phlebotomy'], phone: '+919800000108' },
  { id: 'a0000000-0000-4000-8000-000000000009', full_name: 'Imran Qureshi', role: 'field_staff', skills: ['ecg'], phone: '+919800000109' },
  { id: 'a0000000-0000-4000-8000-000000000010', full_name: 'Deepak Pawar', role: 'field_staff', skills: ['xray'], phone: '+919800000110' },
  { id: 'a0000000-0000-4000-8000-000000000011', full_name: 'Lata Gaikwad', role: 'field_staff', skills: ['phlebotomy', 'ecg'], phone: '+919800000111' },
  { id: 'a0000000-0000-4000-8000-000000000012', full_name: 'Neha Kulkarni', role: 'client_manager', email: 'programme.owner@hinduja.demo' },
  { id: 'a0000000-0000-4000-8000-000000000013', full_name: 'Dr. S. Mehta', role: 'client_clinical', email: 'clinical@hinduja.demo' },
  { id: 'a0000000-0000-4000-8000-000000000014', full_name: 'Platform Admin', role: 'admin', email: 'admin@secondmedic.demo' },
  { id: 'a0000000-0000-4000-8000-000000000017', full_name: 'Demo Administrator', role: 'administrator', email: 'administrator@secondmedic.demo' },
  { id: 'a0000000-0000-4000-8000-000000000015', full_name: 'Ritu Sawant', role: 'provider', provider: 'BMM', email: 'ritu@bookmymedicare.demo' },
  { id: 'a0000000-0000-4000-8000-000000000016', full_name: 'Sachin Bhalerao', role: 'provider', provider: 'BMM', email: 'sachin@bookmymedicare.demo' },
];

export const ROLE_LABEL = {
  agent: 'Contact centre agent', coordinator: 'Coordinator', supervisor: 'Supervisor', field_staff: 'Field staff',
  medical_desk: 'Medical desk', client_manager: 'Hinduja management', client_clinical: 'Hinduja clinical', admin: 'Platform admin', provider: 'Service provider', administrator: 'Administrator',
};

const LOCALITIES = [
  ['Andheri', 'Andheri West', '400058', 19.1364, 72.8296], ['Andheri', 'Lokhandwala', '400053', 19.1416, 72.8258],
  ['Andheri', 'Andheri East', '400069', 19.1136, 72.8697], ['Andheri', 'Chakala', '400093', 19.1110, 72.8600],
  ['Bandra–Khar', 'Bandra West', '400050', 19.0596, 72.8295], ['Bandra–Khar', 'Khar West', '400052', 19.0726, 72.8362],
  ['Bandra–Khar', 'Bandra East', '400051', 19.0626, 72.8490], ['Mahim–Dadar', 'Dadar West', '400028', 19.0186, 72.8423],
  ['Mahim–Dadar', 'Mahim', '400016', 19.0390, 72.8400], ['Mahim–Dadar', 'Prabhadevi', '400025', 19.0166, 72.8295],
  ['Powai', 'Hiranandani Gardens', '400076', 19.1176, 72.9060], ['Powai', 'Saki Naka', '400072', 19.1030, 72.8890],
  ['Thane', 'Thane West', '400601', 19.1970, 72.9630], ['Thane', 'Majiwada', '400601', 19.2135, 72.9790], ['Thane', 'Vartak Nagar', '400606', 19.2210, 72.9780],
];
const DIDS = ['+918049368621']; // Hinduja helpline (MyOperator)
const STREETS = ['Link Road', 'S.V. Road', 'Hill Road', 'Carter Road', 'L.B.S. Marg', 'Gokhale Road', 'Ghodbunder Road', 'J.P. Road', 'Turner Road', 'Ranade Road', 'Orchard Avenue', 'Central Avenue'];
const BUILDINGS = ['Sai Krupa CHS', 'Shanti Niwas', 'Gulmohar Apts', 'Sea Breeze', 'Neelkanth Heights', 'Mahavir Tower', 'Ashirwad', 'Silver Oak', 'Kailash Darshan', 'Rustomjee Elanza', 'Lodha Amara', 'Hiranandani Eden'];
const FIRST_M = ['Ramesh', 'Suresh', 'Vijay', 'Anil', 'Prakash', 'Mohan', 'Ashok', 'Dilip', 'Narayan', 'Jayant', 'Rajendra', 'Shashikant', 'Hasan', 'Joseph', 'Gurpreet'];
const FIRST_F = ['Sunita', 'Kamala', 'Shobha', 'Asha', 'Usha', 'Meenakshi', 'Lalita', 'Pushpa', 'Vandana', 'Rekha', 'Farida', 'Maria', 'Harpreet'];
const LAST = ['Sharma', 'Deshpande', 'Kulkarni', 'Mehta', 'Shah', 'Iyer', 'Naik', 'Joshi', 'Patil', 'Desai', 'Fernandes', 'Khan', 'Gupta', 'Rao', 'Bhosale', 'Kapoor', 'Menon', 'Thakur', 'Sawant', 'Pillai'];
const RELATIONS = ['son', 'daughter', 'self', 'wife', 'husband', 'daughter-in-law', 'nephew', 'caretaker'];
const COMBOS = [
  ['LAB-PANEL', 'ECG-12'], ['LAB-CBC', 'LAB-LFT', 'LAB-KFT'], ['XR-CHEST'], ['ECG-12'], ['LAB-THY', 'LAB-HBA1C'],
  ['LAB-LIPID', 'LAB-HBA1C', 'ECG-12'], ['LAB-PANEL'], ['XR-LIMB'], ['LAB-CBC'], ['LAB-KFT', 'LAB-CBC'],
];
const CANCEL_REASONS = ['Patient hospitalised', 'Rescheduled by family, new case', 'Price concern', 'Booked elsewhere', 'Duplicate enquiry'];

function rng(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const q = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (Array.isArray(v)) return `array[${v.map(q).join(',')}]::text[]`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const uuid = (r) => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const n = Math.floor(r() * 16); return (c === 'x' ? n : (n & 0x3) | 0x8).toString(16); });

export function buildSeedSql({ ws, services, templates, zones, now = new Date() }) {
  const r = rng(20260923);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const between = (a, b) => a + r() * (b - a);
  const min = (d, m) => new Date(d.getTime() + m * 60000);
  const out = [];
  const ins = (table, rows) => {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    for (let i = 0; i < rows.length; i += 200) {
      out.push(`insert into ${table} (${cols.join(',')}) values\n` + rows.slice(i, i + 200).map((row) => '(' + cols.map((c) => q(row[c])).join(',') + ')').join(',\n') + ';');
    }
  };
  const svc = Object.fromEntries(services.map((s) => [s.code, s]));
  const tpl = Object.fromEntries(templates.map((t) => [t.code, t]));
  const zoneId = Object.fromEntries(zones.map((z) => [z.name, z.id]));
  const byRole = (role, i = 0) => DEMO_USERS.filter((u) => u.role === role)[i];
  const U = { farhan: byRole('coordinator'), meera: byRole('supervisor'), anil: byRole('medical_desk'), neha: byRole('client_manager'), mehta: byRole('client_clinical') };
  const agents = DEMO_USERS.filter((u) => u.role === 'agent');
  const field = DEMO_USERS.filter((u) => u.role === 'field_staff');

  ins('profiles', DEMO_USERS.filter((u) => u.role !== 'provider').map((u) => ({
    id: u.id, workspace_id: ws, full_name: u.full_name, email: u.email || null, phone: u.phone || null, role: u.role,
    agent_code: u.agent_code || null, myoperator_user_id: u.myoperator_user_id || null, skills: u.skills || [],
    zone_id: null, on_duty: true, active: true,
  })));
  // provider logins point at their provider (made by the migrations)
  for (const u of DEMO_USERS.filter((x) => x.role === 'provider')) {
    out.push(`insert into profiles (id, workspace_id, full_name, email, role, provider_id, on_duty, active) values (${q(u.id)}, ${q(ws)}, ${q(u.full_name)}, ${q(u.email)}, 'provider', (select id from providers where workspace_id = ${q(ws)} and code = ${q(u.provider)}), true, true);`);
  }

  // ---------- patients
  const patients = [];
  for (let i = 0; i < 64; i++) {
    const g = r() < 0.52 ? 'M' : 'F';
    const loc = LOCALITIES[i % LOCALITIES.length];
    const lat = loc[3] + between(-0.006, 0.006), lng = loc[4] + between(-0.006, 0.006);
    patients.push({
      id: uuid(r), workspace_id: ws, mrn: `P-26${String(9 + (i % 2)).padStart(2, '0')}-${(0xA1B2C3 + i * 7919).toString(16).toUpperCase().slice(-6)}`,
      full_name: `${g === 'M' ? 'Mr.' : 'Mrs.'} ${pick(g === 'M' ? FIRST_M : FIRST_F)} ${pick(LAST)}`,
      age: Math.round(between(48, 89)), gender: g, mobile: '+9198' + String(20000000 + Math.floor(r() * 79999999)).slice(0, 8),
      email: r() < 0.3 ? `family${i}@example.com` : null,
      address: `${Math.floor(between(1, 40))}${r() < 0.5 ? '/' + Math.floor(between(1, 20)) : ''}, ${pick(BUILDINGS)}, ${pick(STREETS)}`,
      landmark: pick(['Near Shoppers Stop', 'Opp. Municipal School', 'Behind Petrol Pump', 'Next to Axis Bank', 'Near Railway Station', 'Opp. Hanuman Mandir']),
      locality: loc[1], pincode: loc[2], city: loc[0] === 'Thane' ? 'Thane' : 'Mumbai', zone_id: zoneId[loc[0]],
      lat, lng, consent_verbal_at: null, consent_digital_at: null, created_by: pick(agents).id,
      created_at: null,
    });
  }

  const cases = [], items = [], history = [], inter = [], calls = [], timers = [], asg = [], samples = [], pays = [], qa = [];
  const approvals = [], complaints = [], escalations = [], callbacks = [], notes = [], access = [];
  const counters = {};
  const fmtDay = (d) => { const x = new Date(d.getTime() + 5.5 * 3600e3); return x.toISOString().slice(2, 10).replace(/-/g, ''); };
  const istMidnight = (offset) => { const x = new Date(now.getTime() + 5.5 * 3600e3); x.setUTCHours(0, 0, 0, 0); return new Date(x.getTime() - 5.5 * 3600e3 + offset * 86400e3); };

  let pi = 0;
  let forcedPending = 0;
  const STAGES = ['enquiry', 'pricing', 'booking', 'deployment', 'completion', 'payment', 'closure', 'closed'];
  const addI = (c, at, channel, direction, actor, summary, extra = {}) => inter.push({
    id: uuid(r), workspace_id: ws, case_id: c.id, patient_id: c.patient_id, channel, direction, actor_id: actor?.id || null,
    actor_label: actor ? (actor.agent_code || actor.full_name) : 'System', summary, body: extra.body || null, evidence: extra.evidence || null,
    call_id: extra.call_id || null, template_id: extra.template_id || null, occurred_at: at, meta: {},
  });

  for (let day = -6; day <= 0; day++) {
    const base = istMidnight(day);
    const n = day === 0 ? 15 : Math.round(between(10, 15));
    const times = Array.from({ length: n }, () => min(base, between(7.5 * 60, 21 * 60))).sort((a, b) => a - b)
      .filter((t) => t < min(now, -25));
    for (const created of times) {
      const p = patients[pi++ % patients.length];
      if (!p.created_at || created < new Date(p.created_at)) p.created_at = created;
      const owner = pick(agents);
      const urgent = r() < 0.22;
      const channel = r() < 0.66 ? 'phone' : r() < 0.75 ? 'whatsapp' : 'email';
      const combo = pick(COMBOS);
      const dk = fmtDay(created);
      counters[dk] = (counters[dk] || 0) + 1;
      const c = {
        id: uuid(r), workspace_id: ws, case_no: `HHC-${dk}-${String(counters[dk]).padStart(5, '0')}`, patient_id: p.id,
        caller_name: r() < 0.25 ? p.full_name.replace(/^(Mr\.|Mrs\.) /, '') : `${pick([...FIRST_M, ...FIRST_F])} ${p.full_name.split(' ').pop()}`,
        caller_relation: r() < 0.25 ? 'self' : pick(RELATIONS), caller_mobile: '+9198' + String(Math.floor(between(20000000, 99999999))),
        source_channel: channel, stage: 'enquiry', priority: urgent ? 'urgent' : 'routine',
        services_requested: combo.map((k) => svc[k].name).join(' + '), clinical_notes: null,
        preferred_slot: null, booked_slot: null, address: p.address, pincode: p.pincode, zone_id: p.zone_id,
        owner_id: owner.id, coordinator_id: null, subtotal: 0, discount_pct: 0, discount_amount: 0, total: 0,
        quote_status: 'draft', quote_template_id: null, quote_sent_at: null, booking_confirmed_at: null, service_completed_at: null,
        amount_collected: 0, payment_status: 'unpaid', report_status: 'pending', report_delivered_at: null,
        feedback_rating: null, feedback_text: null, cancel_reason: null, reopen_reason: null, closed_at: null, closed_by: null,
        sla_state: 'ok', ai_brief: null, created_by: owner.id, created_at: created, updated_at: created,
      };
      if (!p.consent_verbal_at) p.consent_verbal_at = min(created, 2);
      let subtotal = 0;
      for (const k of [...combo, urgent ? 'VISIT-URG' : 'VISIT-STD']) {
        const s = svc[k];
        items.push({ id: uuid(r), case_id: c.id, service_id: s.id, service_code: s.code, service_name: s.name, category: s.category,
          unit_price: s.price, qty: 1, line_total: s.price, created_at: min(created, 3) });
        subtotal += Number(s.price);
      }
      let disc = r() < 0.18 ? (r() < 0.4 ? 15 : 10) : 0;
      const ageH0 = (now - created) / 3600e3;
      if (ageH0 < 4 && ageH0 > 0.5 && forcedPending < 2) { disc = forcedPending ? 20 : 15; forcedPending++; }
      c.subtotal = subtotal; c.discount_pct = disc; c.discount_amount = Math.round(subtotal * disc) / 100; c.total = subtotal - c.discount_amount;

      // ----- timeline
      let call = null;
      if (channel === 'phone') {
        const ring = Math.round(between(4, r() < 0.1 ? 45 : 26)), talk = Math.round(between(140, 420));
        call = { id: uuid(r), workspace_id: ws, provider: 'myoperator', session_id: 'demo-' + uuid(r).slice(0, 13), provider_call_id: null,
          direction: 'inbound', customer_number: c.caller_mobile, did_number: DIDS[Math.floor(r() * 2) % DIDS.length], agent_id: owner.id, agent_name: owner.full_name,
          department: 'HHCS', status: 'completed', started_at: created, answered_at: new Date(created.getTime() + ring * 1000),
          ended_at: new Date(created.getTime() + (ring + talk) * 1000), ring_seconds: ring, talk_seconds: talk,
          recording_filename: 'demo-recording.mp3', patient_id: p.id, case_id: c.id, disposition: 'New enquiry', notes: null,
          transcript: null, ai_summary: `${c.caller_relation === 'self' ? 'Patient' : 'Caller (' + c.caller_relation + ')'} requested ${c.services_requested.toLowerCase()} at home in ${p.locality}${urgent ? ', urgently' : ''}. Consent taken; quote to be shared on WhatsApp.`,
          ai_sentiment: pick(['neutral', 'positive', 'neutral', 'distressed']), ai_intent: 'new_booking',
          ai_extracted: { patient_name: p.full_name, age: p.age, pincode: p.pincode, consent_given: true, language: pick(['English', 'Hindi', 'Marathi']) },
          ai_flags: urgent && r() < 0.3 ? ['patient feeling weak'] : [], ai_processed_at: min(created, 8), click_to_call_ref: null, raw: null, created_at: created };
        calls.push(call);
        addI(c, created, 'phone', 'inbound', owner, `Inbound call answered in ${ring} s · ${owner.agent_code}`, { evidence: `Recording ${Math.floor(talk / 60)}:${String(talk % 60).padStart(2, '0')}`, call_id: call.id });
        if (r() < 0.55) {
          const g = (x) => Math.max(2, Math.min(5, Math.round(x)));
          const sc = { greeting: g(between(3.5, 5.4)), consent: g(between(3, 5.4)), price_accuracy: g(between(3.8, 5.4)), empathy: g(between(2.8, 5.4)), closure: g(between(3, 5.4)) };
          qa.push({ id: uuid(r), workspace_id: ws, call_id: call.id, agent_id: owner.id, reviewer_id: r() < 0.5 ? U.meera.id : null, ...sc,
            total_pct: Math.round(((sc.greeting + sc.consent + sc.price_accuracy + sc.empathy + sc.closure) / 25) * 1000) / 10,
            notes: pick(['Clear consent and accurate quote.', 'Read back the address with landmark.', 'Good empathy with an anxious caller.', 'Close with the case reference every time.']),
            coaching_action: null, ai_generated: r() < 0.6, created_at: min(created, 20) });
        }
      } else {
        addI(c, created, channel, 'inbound', null, channel === 'whatsapp' ? 'WhatsApp message received' : 'Email received, ticket created',
          { body: `Need ${c.services_requested.toLowerCase()} at home for my ${c.caller_relation === 'self' ? 'self' : 'father'} in ${p.locality}. Please share charges.`, evidence: 'Message copy' });
        const ackAt = min(created, between(1, channel === 'email' ? 7 : 5.5));
        addI(c, ackAt, channel, 'outbound', owner, 'Acknowledged on approved template T-08', { template_id: tpl['T-08'].id, evidence: 'Message copy' });
        timers.push(timer(c, 'ack', created, 5, ackAt));
      }
      history.push({ case_id: c.id, from_stage: null, to_stage: 'enquiry', changed_by: owner.id, changed_at: min(created, 2), note: 'Case created' });
      addI(c, min(created, 2), 'system', 'internal', owner, 'Enquiry captured · consent recorded · case ID generated');

      // target stage
      const ageH = (now - created) / 3600e3;
      let target;
      if (r() < 0.07 && ageH > 1) target = 'cancelled';
      else if (ageH > 52) target = r() < 0.9 ? 'closed' : 'closure';
      else if (ageH > 26) target = pick(['closed', 'closed', 'closure', 'payment', 'closed']);
      else if (ageH > 8) target = pick(['closure', 'payment', 'completion', 'deployment', 'closed']);
      else if (ageH > 3) target = pick(['booking', 'deployment', 'deployment', 'completion', 'pricing']);
      else target = pick(['enquiry', 'pricing', 'pricing', 'booking', 'deployment']);
      if (disc > 10 && ageH < 4) target = 'pricing';
      const targetIdx = target === 'cancelled' ? Math.floor(between(1, 3)) : STAGES.indexOf(target);
      let t = min(created, 3);
      const stamp = (from, to, at, who) => { history.push({ case_id: c.id, from_stage: from, to_stage: to, changed_by: who.id, changed_at: at, note: null }); addI(c, at, 'system', 'internal', who, `Stage: ${from} → ${to}`); c.stage = to; c.updated_at = at; };

      if (targetIdx >= 1) { stamp('enquiry', 'pricing', t, owner); }
      // pricing
      if (targetIdx >= 1) {
        const quoteMins = between(3, r() < 0.12 ? 16 : 9);
        if (disc > 10) {
          const decided = ageH > 4 || targetIdx >= 2;
          approvals.push({ id: uuid(r), workspace_id: ws, case_id: c.id, kind: 'discount', title: `Discount ${disc}% on ${c.case_no}`,
            payload: { requested_pct: disc, band_pct: 10, subtotal, discount_amount: c.discount_amount, reason: pick(['Senior citizen, repeat patient', 'Family requested concession', 'Ex-employee of Hinduja']) },
            status: decided ? 'approved' : 'pending', requested_by: owner.id, requested_at: min(t, 1), decided_by: decided ? U.neha.id : null,
            decided_at: decided ? min(t, quoteMins - 1) : null, decision_note: decided ? 'Approved within policy' : null });
          addI(c, min(t, 1), 'system', 'internal', owner, `Quote blocked: ${disc}% exceeds approved band of 10% · approval requested`);
          if (decided) addI(c, min(t, quoteMins - 1), 'system', 'internal', U.neha, 'Discount APPROVED by client approver');
          c.quote_status = decided ? 'approved' : 'pending_approval';
        } else c.quote_status = 'approved';
        if (targetIdx >= 2 || (targetIdx === 1 && r() < 0.4 && c.quote_status === 'approved')) {
          const qs = min(t, quoteMins);
          c.quote_status = 'sent'; c.quote_sent_at = qs; c.quote_template_id = tpl['T-03'].id;
          addI(c, qs, 'whatsapp', 'outbound', owner, 'Quote sent using approved template T-03', { template_id: tpl['T-03'].id, evidence: 'Message copy',
            body: `Reference: ${c.case_no}\nServices: ${c.services_requested}\nTotal payable: ₹${c.total}` });
          timers.push(timer(c, 'quote', t, 10, qs));
          t = qs;
        } else if (targetIdx === 1) timers.push(timer(c, 'quote', t, 10, null));
      }
      if (targetIdx >= 2) { stamp('pricing', 'booking', min(t, 1), owner); t = min(t, 1); }
      const coord = U.farhan;
      let slot = null;
      if (targetIdx >= 2) {
        const bk = min(t, between(4, r() < 0.1 ? 20 : 13));
        slot = urgent ? min(bk, between(60, 110)) : (() => { const s = new Date(bk); const h = new Date(s.getTime() + 5.5 * 3600e3).getUTCHours(); return h >= 16 ? min(istMidnight(Math.round((bk - istMidnight(0)) / 86400e3) + 1), between(7 * 60, 10 * 60)) : min(bk, between(90, 240)); })();
        c.preferred_slot = slot;
        if (targetIdx >= 3 || r() < 0.5) {
          c.booked_slot = slot; c.booking_confirmed_at = bk; c.coordinator_id = coord.id;
          addI(c, bk, 'whatsapp', 'outbound', owner, `Booking confirmed · confirmation sent (T-04)`, { template_id: tpl['T-04'].id, evidence: 'Message copy' });
          timers.push(timer(c, 'booking', t, 15, bk));
          t = bk;
        } else timers.push(timer(c, 'booking', t, 15, null));
      }
      if (targetIdx >= 3) { stamp('booking', 'deployment', min(t, 2), coord); t = min(t, 2); }
      const tasks = [...new Set(combo.map((k) => svc[k].category))].map((cat) => (cat === 'lab' ? 'phlebotomy' : cat));
      if (targetIdx >= 3) {
        for (const task of tasks) {
          const staff = field.filter((f) => f.skills.includes(task));
          const s = pick(staff.length ? staff : field);
          const eta = min(slot, between(-12, 8));
          const arrived = targetIdx >= 4 || (slot < now && r() < 0.6);
          const late = r() < 0.12;
          const checkin = arrived ? min(slot, late ? between(18, 40) : between(-14, 12)) : null;
          const done = targetIdx >= 5 || (targetIdx === 4 && r() < 0.5);
          const a = { id: uuid(r), workspace_id: ws, case_id: c.id, staff_id: s.id, task, status: done ? 'completed' : arrived ? 'checked_in' : (slot - now < 40 * 60000 ? 'en_route' : 'assigned'),
            assigned_by: coord.id, assigned_at: min(t, 3), eta, window_start: min(slot, -120), window_end: min(slot, 240),
            checkin_at: checkin, checkin_lat: checkin ? p.lat + between(-0.0004, 0.0004) : null, checkin_lng: checkin ? p.lng + between(-0.0004, 0.0004) : null,
            checkin_distance_m: checkin ? Math.round(between(8, 70)) : null, checkout_at: done ? min(checkin, between(18, 38)) : null,
            checklist: done ? { consent: true, id_check: true, procedure: true } : {}, patient_signoff: done, backup_for: null, delay_reason: late ? 'Traffic on Western Express Highway' : null };
          asg.push(a);
          addI(c, a.assigned_at, 'field', 'internal', coord, `Assigned ${s.full_name} (${task}) · ETA ${istTime(eta)}`);
          addI(c, min(t, 4), 'sms', 'outbound', null, 'ETA and technician name shared', { evidence: 'Delivery receipt', template_id: tpl['T-05'].id });
          if (checkin) addI(c, checkin, 'field', 'internal', s, `Geo-tagged check-in at patient address · ${a.checkin_distance_m} m from pin`, { evidence: 'GPS' });
          if (late && checkin) escalations.push({ id: uuid(r), workspace_id: ws, case_id: c.id, complaint_id: null, type: 'delay', level: 1,
            trigger_text: `Field delay: ${a.delay_reason}`, raised_by: s.id, raised_at: min(slot, -5), contacted_name: 'Hinduja coordinator desk', contacted_at: min(slot, -2),
            outcome: 'Patient informed of revised ETA', status: 'resolved', acknowledged_by: coord.id, acknowledged_at: min(slot, -3), resolved_at: checkin, auto_raised: false });
          if (done) addI(c, a.checkout_at, 'field', 'internal', s, `Visit completed · ${task} · patient sign-off yes`);
          timers.push(timer(c, urgent ? 'arrival_urgent' : 'arrival_slot', urgent ? created : min(t, 3), urgent ? 120 : null, checkin, urgent ? null : min(slot, 15)));
        }
        if (!p.consent_digital_at && targetIdx >= 5) p.consent_digital_at = slot;
      }
      if (targetIdx >= 4) {
        const ci = asg.filter((a) => a.case_id === c.id).map((a) => a.checkin_at).filter(Boolean).sort((a, b) => a - b)[0] || slot;
        stamp('deployment', 'completion', ci, coord); t = ci;
        if (tasks.includes('phlebotomy') || tasks.includes('ecg')) {
          const bc = 'HB' + String(Math.floor(between(1000000, 9999999)));
          const coll = min(ci, 12);
          const later = (m) => (targetIdx >= 6 ? min(coll, m) : null);
          const critical = r() < 0.04;
          samples.push({ id: uuid(r), workspace_id: ws, case_id: c.id, barcode: bc, kind: tasks.includes('phlebotomy') ? 'blood' : 'ecg', collected_at: coll,
            handover_at: targetIdx >= 5 ? min(coll, 70) : null, dispatched_at: targetIdx >= 5 ? min(coll, 80) : null, transport_temp_c: targetIdx >= 5 ? 4.2 + Math.round(between(0, 30)) / 10 : null,
            received_at: targetIdx >= 5 ? min(coll, 135) : null, accessioned_at: targetIdx >= 5 ? min(coll, 145) : null,
            report_released_at: later(between(600, 1200)), delivered_at: later(between(1210, 1300)), critical_flag: critical, critical_note: critical ? 'Potassium 6.4 mmol/L' : null, file_url: null });
          addI(c, coll, 'lab', 'internal', null, `Samples barcoded ${bc}${tasks.includes('ecg') ? ' · ECG captured & uploaded' : ''}`);
          if (critical) escalations.push({ id: uuid(r), workspace_id: ws, case_id: c.id, complaint_id: null, type: 'clinical', level: 2, trigger_text: `Critical value on ${bc}: Potassium 6.4 mmol/L`,
            raised_by: U.anil.id, raised_at: later(between(600, 610)) || min(coll, 600), contacted_name: 'Dr. S. Mehta (Hinduja clinical)', contacted_at: min(coll, 603), outcome: 'Hinduja clinical called family; advised ER visit', status: 'resolved',
            acknowledged_by: U.mehta.id, acknowledged_at: min(coll, 603), resolved_at: min(coll, 640), auto_raised: false });
        }
      }
      if (targetIdx >= 5) {
        const done = asg.filter((a) => a.case_id === c.id).map((a) => a.checkout_at).filter(Boolean).sort((a, b) => b - a)[0] || min(t, 30);
        c.service_completed_at = done;
        stamp('completion', 'payment', done, coord); t = done;
        const mode = pick(['upi', 'upi', 'link', 'card']);
        const paid = targetIdx >= 6 || r() < 0.7;
        if (paid) {
          const at = min(done, 2);
          const rec = targetIdx >= 6 || ageH > 20;
          pays.push({ id: uuid(r), workspace_id: ws, case_id: c.id, amount: c.total, mode, txn_ref: mode === 'card' ? 'POS' + Math.floor(between(1e5, 9e5)) : 'UPI' + Math.floor(between(1e9, 9e9)),
            receipt_no: `RCPT-${c.case_no.replace(/-/g, '')}-1`, collected_by: asg.find((a) => a.case_id === c.id)?.staff_id, collected_at: at, gateway_status: 'captured',
            settled_at: rec ? min(istMidnight(Math.ceil((at - istMidnight(0)) / 86400e3)), 10 * 60) : null, reconciled: rec, reconciled_at: rec ? min(istMidnight(Math.ceil((at - istMidnight(0)) / 86400e3)), 10.5 * 60) : null,
            reconciled_by: rec ? U.meera.id : null, exception: null });
          c.amount_collected = c.total; c.payment_status = rec ? 'reconciled' : 'paid';
          addI(c, at, 'payment', 'internal', null, `Payment ₹${c.total} via ${mode.toUpperCase()} · receipt issued`, { evidence: 'Txn ref' });
        }
      }
      if (targetIdx >= 6) {
        const rec = pays.find((x) => x.case_id === c.id)?.reconciled_at || min(t, 600);
        stamp('payment', 'closure', rec, U.meera); t = rec;
        const sm = samples.find((s) => s.case_id === c.id);
        const del = sm?.delivered_at && sm.delivered_at < now ? sm.delivered_at : (tasks.includes('xray') && ageH > 14 ? min(t, 40) : null);
        if (del) { c.report_status = 'delivered'; c.report_delivered_at = del; addI(c, del, 'whatsapp', 'outbound', null, 'Report delivered (T-07)', { template_id: tpl['T-07'].id, evidence: 'Message copy' }); }
        else c.report_status = sm?.report_released_at && sm.report_released_at < now ? 'released' : 'pending';
        if (targetIdx >= 7 && c.report_status === 'delivered') {
          c.feedback_rating = pick([5, 5, 4, 5, 4, 3]); c.feedback_text = pick(['Technician was punctual and polite.', 'Smooth process, report on time.', 'Good, but arrival was a bit late.', 'Very professional staff.']);
          addI(c, min(del, 90), 'note', 'internal', owner, `Feedback captured · ${c.feedback_rating}/5`, { body: c.feedback_text });
          const cl = min(del, 95);
          c.closed_at = cl; c.closed_by = owner.id;
          stamp('closure', 'closed', cl, owner);
        }
      }
      if (target === 'cancelled') {
        c.cancel_reason = pick(CANCEL_REASONS);
        const at = min(t, between(10, 60));
        history.push({ case_id: c.id, from_stage: c.stage, to_stage: 'cancelled', changed_by: owner.id, changed_at: at, note: c.cancel_reason });
        addI(c, at, 'system', 'internal', owner, 'Case cancelled', { body: c.cancel_reason });
        c.stage = 'cancelled';
        timers.forEach((x) => { if (x.case_id === c.id && x.status === 'running') x.status = 'cancelled'; });
        asg.forEach((a) => { if (a.case_id === c.id && ['assigned', 'en_route'].includes(a.status)) a.status = 'cancelled'; });
      }
      const running = timers.filter((x) => x.case_id === c.id && x.status === 'running');
      if (timers.some((x) => x.case_id === c.id && x.status === 'breached') && !['closed', 'cancelled'].includes(c.stage)) c.sla_state = 'breached';
      else if (running.some((x) => now > new Date(x.started_at.getTime() + (x.due_at - x.started_at) * 0.75))) c.sla_state = 'at_risk';
      cases.push(c);
    }
  }

  function timer(c, key, start, mins, metAt, dueOverride) {
    const due = dueOverride || min(start, mins);
    const breached = (metAt && metAt > due) || (!metAt && due < now);
    return { id: uuid(r), workspace_id: ws, policy_key: key, case_id: c.id, complaint_id: null, callback_id: null, started_at: start, due_at: due,
      met_at: metAt || null, breached_at: breached ? due : null, status: metAt ? (breached ? 'breached' : 'met') : breached ? 'breached' : 'running' };
  }
  function istTime(d) { const x = new Date(d.getTime() + 5.5 * 3600e3); return x.toISOString().slice(11, 16); }

  // ---------- extra calls: missed, abandoned, outbound callbacks, report queries
  for (let day = -6; day <= 0; day++) {
    const base = istMidnight(day);
    const n = Math.round(between(9, 14));
    for (let i = 0; i < n; i++) {
      const at = min(base, between(7 * 60, 22 * 60));
      if (at > min(now, -1)) continue;
      const p = pick(patients);
      const kind = r();
      const ag = pick(agents);
      const missed = kind < 0.16, aband = kind >= 0.16 && kind < 0.22;
      const ring = Math.round(between(3, 28)), talk = missed || aband ? 0 : Math.round(between(40, 260));
      const id = uuid(r);
      calls.push({ id, workspace_id: ws, provider: 'myoperator', session_id: 'demo-' + uuid(r).slice(0, 13), provider_call_id: null, direction: kind > 0.6 ? 'outbound' : 'inbound',
        customer_number: p.mobile, did_number: DIDS[Math.floor(r() * 2) % DIDS.length], agent_id: missed || aband ? null : ag.id, agent_name: missed || aband ? null : ag.full_name, department: 'HHCS',
        status: missed ? 'missed' : aband ? 'abandoned' : 'completed', started_at: at, answered_at: missed || aband ? null : new Date(at.getTime() + ring * 1000),
        ended_at: new Date(at.getTime() + (ring + talk) * 1000), ring_seconds: missed || aband ? null : ring, talk_seconds: talk, recording_filename: talk ? 'demo-recording.mp3' : null,
        patient_id: p.id, case_id: null, disposition: missed || aband ? null : pick(['Report query', 'Slot reschedule', 'Price enquiry', 'Follow-up', 'Feedback call']), notes: null,
        transcript: null, ai_summary: talk ? pick(['Caller asked for the report timeline; informed as per lab TAT.', 'Family asked to move tomorrow\'s slot to 9 am; coordinator to confirm.', 'Price enquiry for ECG at home; rate card price shared.', 'Feedback call after visit; patient satisfied.']) : null,
        ai_sentiment: talk ? pick(['neutral', 'positive', 'negative']) : null, ai_intent: talk ? pick(['report_query', 'reschedule', 'price_enquiry', 'other']) : null,
        ai_extracted: null, ai_flags: [], ai_processed_at: talk ? min(at, 5) : null, click_to_call_ref: null, raw: null, created_at: at });
      if (missed || aband) {
        const due = min(at, 10);
        const done = at < min(now, -12) ? min(at, between(3, r() < 0.15 ? 18 : 9)) : null;
        const cb = { id: uuid(r), workspace_id: ws, call_id: id, number: p.mobile, patient_id: p.id, reason: aband ? 'abandoned' : 'missed', due_at: due,
          status: done ? 'done' : 'pending', assigned_to: done ? ag.id : null, attempts: done ? 1 : 0, last_attempt_at: done, completed_at: done, completed_by: done ? ag.id : null, created_at: at };
        callbacks.push(cb);
        timers.push({ id: uuid(r), workspace_id: ws, policy_key: 'missed_callback', case_id: null, complaint_id: null, callback_id: cb.id, started_at: at, due_at: due,
          met_at: done, breached_at: (done && done > due) || (!done && due < now) ? due : null, status: done ? (done > due ? 'breached' : 'met') : due < now ? 'breached' : 'running' });
      }
    }
  }
  // two fresh missed calls waiting for callback right now
  for (const m of [3, 7]) {
    const p = pick(patients); const at = min(now, -m); const id = uuid(r);
    calls.push({ id, workspace_id: ws, provider: 'myoperator', session_id: 'demo-' + uuid(r).slice(0, 13), provider_call_id: null, direction: 'inbound', customer_number: p.mobile,
      did_number: DIDS[Math.floor(r() * 2) % DIDS.length], agent_id: null, agent_name: null, department: 'HHCS', status: 'missed', started_at: at, answered_at: null, ended_at: min(at, 0.5),
      ring_seconds: null, talk_seconds: 0, recording_filename: null, patient_id: p.id, case_id: null, disposition: null, notes: null, transcript: null, ai_summary: null,
      ai_sentiment: null, ai_intent: null, ai_extracted: null, ai_flags: [], ai_processed_at: null, click_to_call_ref: null, raw: null, created_at: at });
    const cb = { id: uuid(r), workspace_id: ws, call_id: id, number: p.mobile, patient_id: p.id, reason: 'missed', due_at: min(at, 10), status: 'pending', assigned_to: null,
      attempts: 0, last_attempt_at: null, completed_at: null, completed_by: null, created_at: at };
    callbacks.push(cb);
    timers.push({ id: uuid(r), workspace_id: ws, policy_key: 'missed_callback', case_id: null, complaint_id: null, callback_id: cb.id, started_at: at, due_at: min(at, 10), met_at: null, breached_at: null, status: 'running' });
  }

  // ---------- complaints
  const closedCases = cases.filter((c) => c.stage === 'closed');
  const liveCases = cases.filter((c) => ['closure', 'payment', 'completion'].includes(c.stage));
  const cmp = [
    [closedCases[2], 'behaviour', 'routine', 'Phlebotomist did not wear ID card; family uncomfortable.', 'resolved', 'Staff re-briefed on ID protocol', 'Uniform & ID check added to visit checklist'],
    [closedCases[9], 'report_delay', 'routine', 'Report not received after 30 hours.', 'resolved', 'Lab TAT exceeded due to re-run', 'Proactive delay message sent'],
    [liveCases[0], 'billing', 'high', 'Charged visit fee twice on UPI.', 'acknowledged', null, null],
    [liveCases[2] || closedCases[4], 'service', 'routine', 'Technician arrived 35 minutes late without a call.', 'open', null, null],
  ];
  cmp.forEach(([c, cat, sev, desc, st, rc, res], i) => {
    if (!c) return;
    const at = min(c.updated_at, 20);
    const k = { id: uuid(r), workspace_id: ws, ref_no: `CMP-${fmtDay(at)}-${['A3F1', 'B71C', 'C0D9', 'D44E'][i]}`, case_id: c.id, patient_id: c.patient_id, category: cat, severity: sev,
      description: desc, status: st, owner_id: U.meera.id, opened_by: c.owner_id, opened_at: at, acknowledged_at: st !== 'open' ? min(at, 9) : null,
      resolved_at: st === 'resolved' ? min(at, 600) : null, root_cause: rc, resolution: res };
    complaints.push(k);
    timers.push({ id: uuid(r), workspace_id: ws, policy_key: 'complaint_ack', case_id: c.id, complaint_id: k.id, callback_id: null, started_at: at, due_at: min(at, 15),
      met_at: k.acknowledged_at, breached_at: null, status: k.acknowledged_at ? 'met' : (min(at, 15) < now ? 'breached' : 'running') });
    timers.push({ id: uuid(r), workspace_id: ws, policy_key: 'complaint_resolve', case_id: c.id, complaint_id: k.id, callback_id: null, started_at: at, due_at: min(at, 2880),
      met_at: k.resolved_at, breached_at: null, status: k.resolved_at ? 'met' : 'running' });
    addI(c, at, 'note', 'internal', U.meera, `Complaint ${k.ref_no} opened · ${cat}`, { body: desc });
  });
  // one open delay escalation today
  const dep = cases.filter((c) => c.stage === 'deployment').pop();
  if (dep) escalations.push({ id: uuid(r), workspace_id: ws, case_id: dep.id, complaint_id: null, type: 'delay', level: 1, trigger_text: 'Technician running late, slot at risk (equipment pickup)',
    raised_by: U.farhan.id, raised_at: min(now, -18), contacted_name: null, contacted_at: null, outcome: null, status: 'open', acknowledged_by: null, acknowledged_at: null, resolved_at: null, auto_raised: false });

  // ---------- notifications for Hinduja users
  notes.push(
    { id: uuid(r), workspace_id: ws, user_id: null, role: 'client_manager', kind: 'warn', title: 'Discount approval needed', body: 'Pending approvals are waiting in your queue', link: '/approvals', read_at: null, created_at: min(now, -9) },
    { id: uuid(r), workspace_id: ws, user_id: null, role: 'client_manager', kind: 'info', title: 'Daily MIS ready', body: 'Yesterday\'s pack is on the MIS page', link: '/mis', read_at: null, created_at: min(istMidnight(0), 10 * 60) },
    { id: uuid(r), workspace_id: ws, user_id: null, role: 'supervisor', kind: 'danger', title: 'Escalation L1 · delay', body: 'Technician running late, slot at risk', link: '/escalations', read_at: null, created_at: min(now, -18) },
  );
  access.push(...[U.neha, U.mehta, U.meera].flatMap((u, i) => [
    { workspace_id: ws, user_id: u.id, action: 'login', entity: null, entity_id: null, meta: {}, at: min(istMidnight(0), (8.5 + i) * 60) },
    { workspace_id: ws, user_id: u.id, action: 'view_case', entity: 'case', entity_id: cases[i * 3].id, meta: {}, at: min(istMidnight(0), (9 + i) * 60) },
  ]), { workspace_id: ws, user_id: U.neha.id, action: 'export', entity: 'mis', entity_id: 'daily', meta: { format: 'xlsx' }, at: min(istMidnight(0), 10.3 * 60) });

  // ---------- branches, provider leads (lead assignment), Book My Medicare cases
  const zoneNameById = Object.fromEntries(zones.map((z) => [z.id, z.name]));
  const branchFor = (zid) => ({ 'Bandra–Khar': 'Khar', 'Mahim–Dadar': 'Mahim' }[zoneNameById[zid]] || (r() < 0.55 ? 'Khar' : 'Mahim'));
  const refs = [];
  const REF_BY_STAGE = { enquiry: 'new', pricing: 'new', booking: 'accepted', deployment: 'scheduled', completion: 'in_progress', payment: 'completed', closure: 'completed', closed: 'completed', cancelled: 'cancelled' };
  for (const c of cases) {
    c.branch = branchFor(c.zone_id);
    c.additional_info = null;
    c.external_ref = null;
    const cats = [...new Set(items.filter((i) => i.case_id === c.id).map((i) => i.category))].filter((k) => ['lab', 'xray', 'ecg', 'visit'].includes(k));
    refs.push({ id: uuid(r), case_id: c.id, code: 'SM', categories: cats, status: REF_BY_STAGE[c.stage] || 'new', created_at: min(c.created_at, 3), updated_at: c.updated_at,
      accepted_at: ['booking', 'deployment', 'completion', 'payment', 'closure', 'closed'].includes(c.stage) ? c.booking_confirmed_at || c.updated_at : null,
      scheduled_at: c.booked_slot || null, completed_at: ['payment', 'closure', 'closed'].includes(c.stage) ? c.service_completed_at || c.updated_at : null,
      decline_reason: null, last_note: null, assigned_to: null });
  }
  const bmmUsers = DEMO_USERS.filter((u) => u.role === 'provider');
  const BMM_COMBOS = [
    [['NURS-HOME'], 'Nursing care at home', 'Bedridden after hip surgery, needs female nurse for 12-hour day shift'],
    [['PHYSIO-HOME'], 'Physiotherapy at home', 'Post-stroke rehab, 5 sessions a week, mornings preferred'],
    [['BED-HOSP', 'ELDER-CARE'], 'Hospital bed and attendant', 'Fowler bed needed by tomorrow; attendant for nights'],
    [['NURS-HOME', 'PHYSIO-HOME'], 'Nursing and physiotherapy', 'Discharged from Hinduja Mahim, wound dressing daily plus physio'],
    [['ELDER-CARE'], 'Elder care attendant', 'Mother 86, dementia; attendant who speaks Marathi'],
    [['HOMECARE'], 'Oxygen concentrator on rent', 'Concentrator 5L for 2 weeks; doctor prescription shared on WhatsApp'],
  ];
  const BMM_FLOW = ['completed', 'completed', 'completed', 'in_progress', 'in_progress', 'scheduled', 'scheduled', 'accepted', 'completed', 'declined', 'scheduled', 'accepted', 'new', 'in_progress', 'new', 'new'];
  BMM_FLOW.forEach((status, i) => {
    const created = min(istMidnight(-6 + Math.floor(i * 6.4 / BMM_FLOW.length)), between(9 * 60, 19 * 60));
    if (created > min(now, -40)) return;
    const p = patients[(i * 7 + 3) % patients.length];
    const owner = pick(agents);
    const [codes, request, info] = BMM_COMBOS[i % BMM_COMBOS.length];
    const dk = fmtDay(created);
    counters[dk] = (counters[dk] || 0) + 1;
    const done = status === 'completed';
    const cap = (d) => (d > min(now, -6) ? min(now, -6 - Math.floor(r() * 30)) : d);   // demo history never in the future
    const tAcc = cap(min(created, between(8, 35))), tSch = cap(min(tAcc, between(30, 240))), tStart = cap(min(tSch, between(600, 1400))), tDone = cap(min(tStart, between(1500, 3500)));
    const lastAt = { new: created, accepted: tAcc, scheduled: tSch, in_progress: tStart, completed: tDone, declined: tAcc }[status];
    const c = { ...cases[0], id: uuid(r), case_no: `HHC-${dk}-${String(counters[dk]).padStart(5, '0')}`, patient_id: p.id,
      caller_name: `${pick([...FIRST_M, ...FIRST_F])} ${p.full_name.split(' ').pop()}`, caller_relation: pick(RELATIONS), caller_mobile: '+9198' + String(Math.floor(between(20000000, 99999999))),
      source_channel: 'phone', stage: done ? 'closed' : 'enquiry', priority: i % 5 === 2 ? 'urgent' : 'routine', services_requested: request, clinical_notes: null,
      preferred_slot: null, booked_slot: null, address: p.address, pincode: p.pincode, zone_id: p.zone_id, owner_id: owner.id, coordinator_id: null,
      subtotal: 0, discount_pct: 0, discount_amount: 0, total: 0, quote_status: 'draft', quote_template_id: null, quote_sent_at: null, booking_confirmed_at: null,
      service_completed_at: done ? tDone : null, amount_collected: 0, payment_status: 'unpaid', report_status: 'na', report_delivered_at: null,
      feedback_rating: done && i % 2 === 0 ? 5 : null, feedback_text: null, cancel_reason: null, reopen_reason: null, closed_at: done ? tDone : null, closed_by: done ? bmmUsers[0].id : null,
      sla_state: 'ok', ai_brief: null, created_by: owner.id, created_at: created, updated_at: lastAt,
      branch: branchFor(p.zone_id), additional_info: info, external_ref: null };
    if (!p.consent_verbal_at) p.consent_verbal_at = min(created, 2);
    cases.push(c);
    const cats = [];
    for (const k of codes) {
      const sv = svc[k];
      if (!sv) continue;
      cats.push(sv.category);
      items.push({ id: uuid(r), case_id: c.id, service_id: sv.id, service_code: sv.code, service_name: sv.name, category: sv.category, unit_price: 0, qty: 1, line_total: 0, created_at: min(created, 3) });
    }
    history.push({ case_id: c.id, from_stage: null, to_stage: 'enquiry', changed_by: owner.id, changed_at: min(created, 2), note: 'Case created' });
    addI(c, min(created, 2), 'phone', 'inbound', owner, 'Enquiry captured from call · case ID generated', { body: request });
    addI(c, min(created, 3), 'system', 'internal', null, `Lead transferred to Book My Medicare · ${[...new Set(cats)].map((x) => x[0].toUpperCase() + x.slice(1)).join(', ')}`,
      { body: 'Shared: case ID, patient details, address and requirements. Call recordings are not shared.' });
    const who = bmmUsers[i % bmmUsers.length];
    const visit = min(tSch, between(900, 1500));
    if (status !== 'new') addI(c, tAcc, status === 'declined' ? 'note' : 'note', 'internal', who, status === 'declined' ? 'Book My Medicare: lead declined' : 'Book My Medicare: lead accepted',
      { body: status === 'declined' ? 'No Marathi-speaking attendant free in this area this week' : `Coordinator ${who.full_name} assigned` });
    if (['scheduled', 'in_progress', 'completed'].includes(status)) addI(c, tSch, 'system', 'internal', who, `Book My Medicare: visit scheduled ${visit.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })}`);
    if (['in_progress', 'completed'].includes(status)) {
      addI(c, tStart, 'note', 'internal', who, 'Book My Medicare: service started', { body: 'Nurse / therapist reached on time; family briefed' });
      addI(c, cap(min(tStart, 240)), 'note', 'internal', who, 'Progress note', { body: pick(['Vitals stable, wound clean', 'Mobility improving, walked 20 m with support', 'Bed installed, patient comfortable', 'Medicines given on schedule']) });
    }
    if (done) {
      addI(c, tDone, 'note', 'internal', who, 'Book My Medicare: service completed', { body: 'Course finished; family satisfied' });
      addI(c, tDone, 'system', 'internal', null, 'Case closed: all provider services completed');
      history.push({ case_id: c.id, from_stage: 'enquiry', to_stage: 'closed', changed_by: who.id, changed_at: tDone, note: 'All provider services completed' });
    }
    refs.push({ id: uuid(r), case_id: c.id, code: 'BMM', categories: [...new Set(cats)], status, created_at: min(created, 3), updated_at: lastAt,
      accepted_at: ['accepted', 'scheduled', 'in_progress', 'completed'].includes(status) ? tAcc : null,
      scheduled_at: ['scheduled', 'in_progress', 'completed'].includes(status) ? visit : null, completed_at: done ? tDone : null,
      decline_reason: status === 'declined' ? 'No Marathi-speaking attendant free in this area this week' : null,
      last_note: status === 'new' ? null : 'Updated by ' + who.full_name, assigned_to: status === 'new' ? null : who.id });
    if (status === 'new') timers.push({ id: uuid(r), workspace_id: ws, policy_key: 'provider_accept', case_id: c.id, complaint_id: null, callback_id: null,
      started_at: min(created, 3), due_at: min(created, 33), met_at: null, breached_at: null, status: min(created, 33) < now ? 'breached' : 'running' });
  });

  // ---------- WhatsApp multi-turn chat bodies & active threads awaiting reply
  for (const x of inter) {
    if (x.channel === 'whatsapp' && !x.body) {
      const k = cases.find((c) => c.id === x.case_id);
      if (x.summary.includes('T-08')) {
        x.body = `Namaste, thank you for contacting Hinduja Home Care. Your reference is ${k?.case_no || ''}. Our care desk will revert shortly.`;
      } else if (x.summary.includes('T-04')) {
        x.body = `Hinduja Home Care booking confirmed for ${k?.case_no || ''}\nServices: ${k?.services_requested || 'Home visit'}\nAddress: ${k?.address || ''} - ${k?.pincode || ''}`;
      } else if (x.summary.includes('T-07')) {
        x.body = `Your report for ${k?.case_no || ''} is ready. For clinical queries call +918049368621.`;
      }
    }
  }
  const openForWa = cases.filter((c) => !['closed', 'cancelled'].includes(c.stage)).slice(-3);
  const followUps = [
    'Please confirm if the technician will carry an ECG machine along with the blood collection kit. Landmark is opposite Shoppers Stop.',
    'We have shared the doctor prescription details. Can we schedule the morning 8:00 AM slot tomorrow?',
    'Thank you for sharing the estimate. Please go ahead and book the morning visit at our Khar West address.',
  ];
  openForWa.forEach((c, idx) => {
    addI(c, min(now, -(14 - idx * 5)), 'whatsapp', 'inbound', null, 'WhatsApp message received', {
      body: followUps[idx % followUps.length],
      evidence: 'Message copy',
    });
  });

  // ---------- write
  patients.forEach((p) => { p.created_at = p.created_at || min(istMidnight(-6), 9 * 60); });
  ins('patients', patients);
  ins('cases', cases);
  ins('case_items', items);
  for (const f of refs) {
    out.push(`insert into case_referrals (id, workspace_id, case_id, provider_id, categories, status, auto, assigned_to, scheduled_at, accepted_at, completed_at, decline_reason, last_note, created_at, updated_at) values (${q(f.id)}, ${q(ws)}, ${q(f.case_id)}, (select id from providers where workspace_id = ${q(ws)} and code = ${q(f.code)}), ${q(f.categories)}, ${q(f.status)}, true, ${q(f.assigned_to)}, ${q(f.scheduled_at)}, ${q(f.accepted_at)}, ${q(f.completed_at)}, ${q(f.decline_reason)}, ${q(f.last_note)}, ${q(f.created_at)}, ${q(f.updated_at)});`);
  }
  ins('case_stage_history', history);
  ins('calls', calls);
  ins('interactions', inter);
  ins('approvals', approvals);
  ins('callbacks', callbacks);
  ins('complaints', complaints);
  ins('sla_timers', timers);
  ins('escalations', escalations);
  ins('assignments', asg);
  ins('samples', samples);
  ins('payments', pays);
  ins('qa_reviews', qa);
  ins('notifications', notes);
  ins('access_log', access);
  out.push(...Object.entries(counters).map(([d, n]) => `insert into case_counters(workspace_id, day, last_value) values (${q(ws)}, to_date('${d}','YYMMDD'), ${n}) on conflict (workspace_id, day) do update set last_value = excluded.last_value;`));
  return out.join('\n');
}
