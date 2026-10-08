// AI layer (Google Gemini, key from Google AI Studio). Every output is advisory: it fills drafts, flags risk and
// scores QA, but prices, stage changes and patient messages still go through the locked workflow.
import { asSystem, connect, pgArray, readAsUser, type Sql } from '../db';
import type { Env } from '../env';
import { recordingUrl } from './myoperator';
import { notifyLive } from './live';

type J = Record<string, any>;
const MODEL = (env: Env) => env.GEMINI_MODEL || 'gemini-2.5-flash';

export async function gemini(env: Env, parts: J[], o: { json?: boolean; temperature?: number; system?: string } = {}): Promise<any> {
  const json = o.json ?? true;
  if (!env.GEMINI_API_KEY) throw new Error('AI is not configured (GEMINI_API_KEY)');
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL(env)}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: o.system ? { parts: [{ text: o.system }] } : undefined,
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: o.temperature ?? 0.2, ...(json ? { responseMimeType: 'application/json' } : {}) },
    }),
  });
  const j = (await res.json()) as J;
  if (!res.ok) throw new Error('Gemini: ' + (j.error?.message || res.status));
  const text = j.candidates?.[0]?.content?.parts?.map((p: J) => p.text).join('') || '';
  return json ? JSON.parse(text.replace(/^```json\s*|```$/g, '')) : text;
}

const SYSTEM = `You support the Hinduja Home Care Services contact centre run by SecondMedic in Mumbai (MMR).
Services: home sample collection, portable X-ray, 12-lead ECG at home. Callers speak English, Hindi or Marathi.
Never give clinical advice. Never invent prices; prices come only from the rate card. Be concise and factual.`;

function toBase64(buf: ArrayBuffer) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000) as unknown as number[]);
  return btoa(s);
}

// ---- 1. Call intelligence: transcript, summary, sentiment, enquiry extraction, QA score, red flags
export async function processCall(env: Env, callId: string, exec?: ExecutionContext) {
  const sql = connect(env);
  try {
    const [call] = await sql`select * from calls where id = ${callId}`;
    if (!call?.recording_filename) throw new Error('No recording on this call');
    const link = await recordingUrl(env, call.recording_filename);
    const audio = await fetch(link);
    if (!audio.ok) throw new Error('Could not download recording');
    const buf = await audio.arrayBuffer();
    if (buf.byteLength > 18 * 1024 * 1024) throw new Error('Recording too large for inline AI processing');
    const mime = audio.headers.get('content-type')?.split(';')[0] || 'audio/mpeg';
    const services = await sql`select code, name from services where workspace_id = ${call.workspace_id} and active`;
    const [script] = await sql`select body from templates where workspace_id = ${call.workspace_id} and code = 'S-01' and status = 'approved' limit 1`;

    const out = await gemini(env, [
      { inlineData: { mimeType: mime, data: toBase64(buf) } },
      { text: `Analyse this recorded ${call.direction} call between a contact-centre agent and a caller.
Return JSON with keys:
transcript (string, speaker-labelled "Agent:"/"Caller:", translated to English if needed),
language (string),
summary (2-3 sentences),
intent (one of: new_booking, reschedule, cancellation, report_query, complaint, price_enquiry, emergency, other),
sentiment (positive|neutral|negative|distressed),
extracted {patient_name, age, gender (M/F/O), caller_name, caller_relation, address, locality, pincode, preferred_slot_text, service_codes (array, only from: ${services.map((s) => s.code + '=' + s.name).join('; ')}), urgent (bool)},
consent_given (bool),
flags (array of short strings: e.g. "chest pain mentioned", "price quoted off rate card", "consent not taken", "angry caller"),
qa {greeting, consent, price_accuracy, empathy, closure} each 0-5, scored against this approved script:
${script?.body || 'Greeting, consent, accurate price, empathy, clear closure.'}
qa_notes (one sentence of coaching for the agent).` },
    ], { system: SYSTEM });

    const q = out.qa || {};
    const total = ['greeting', 'consent', 'price_accuracy', 'empathy', 'closure'].reduce((s, k) => s + (Number(q[k]) || 0), 0);
    const { changed } = await asSystem(sql, async (tx) => {
      await tx`update calls set transcript = ${out.transcript ?? null}, ai_summary = ${out.summary ?? null}, ai_sentiment = ${out.sentiment ?? null},
        ai_intent = ${out.intent ?? null}, ai_extracted = ${tx.json({ ...(out.extracted || {}), consent_given: out.consent_given, language: out.language })},
        ai_flags = ${pgArray((out.flags || []).map(String))}::text[], ai_processed_at = now() where id = ${callId}`;
      await tx`insert into qa_reviews (workspace_id, call_id, agent_id, greeting, consent, price_accuracy, empathy, closure, total_pct, notes, ai_generated)
        values (${call.workspace_id}, ${callId}, ${call.agent_id}, ${q.greeting ?? null}, ${q.consent ?? null}, ${q.price_accuracy ?? null},
          ${q.empathy ?? null}, ${q.closure ?? null}, ${Math.round((total / 25) * 1000) / 10}, ${out.qa_notes ?? null}, true)`;
      // a clinical red flag in the conversation raises an escalation for human review
      const clinical = (out.flags || []).find((f: string) => /chest pain|breath|collapse|unconscious|bleed|fall|stroke|seizure/i.test(f));
      if (clinical && call.case_id) {
        const [open] = await tx`select id from escalations where case_id = ${call.case_id} and type in ('clinical','emergency') and status <> 'resolved' limit 1`;
        if (!open) await tx`insert into escalations (workspace_id, case_id, type, level, trigger_text, auto_raised)
          values (${call.workspace_id}, ${call.case_id}, 'clinical', 1, ${`AI flagged on call: ${clinical}. Please review the recording.`}, true)`;
      }
    });
    if (exec) notifyLive(env, exec, changed);
    return out;
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

// ---- 2. Case brief + next best action (reads as the user, so they only brief cases they can see)
export async function caseBrief(env: Env, sql: Sql, userId: string, caseId: string) {
  const data = await readAsUser(sql, userId, async (tx) => {
    const [c] = await tx`select * from v_cases where id = ${caseId}`;
    if (!c) return null;
    const timeline = await tx`select occurred_at, channel, direction, summary, body from interactions where case_id = ${caseId} order by occurred_at asc limit 60`;
    const [g] = await tx`select case_gates(${caseId}) as g`;
    return { c, timeline, gates: g.g };
  });
  if (!data) throw new Error('Case not found');
  const { c, timeline, gates } = data;
  const out = await gemini(env, [{ text: `Case ${c.case_no}, stage ${c.stage}, priority ${c.priority}, SLA ${c.sla_state} (next due ${c.next_sla_due || 'none'} for ${c.next_sla_key || '-'}).
Patient ${c.patient_name}, ${c.patient_age || '?'}${c.patient_gender || ''}. Services: ${c.service_names || c.services_requested || '-'}. Total ₹${c.total}, collected ₹${c.amount_collected}, payment ${c.payment_status}, report ${c.report_status}.
Open escalations ${c.open_escalations}, open complaints ${c.open_complaints}.
Stage gate checks: ${JSON.stringify(gates?.checks)}
Timeline:\n${timeline.map((t) => `${t.occurred_at} [${t.channel}/${t.direction}] ${t.summary}${t.body ? ' : ' + String(t.body).slice(0, 160) : ''}`).join('\n')}

Return JSON: {"summary": "2 sentences on where this case stands", "next_action": "the single most important next step for the team, imperative", "owner": "agent|coordinator|supervisor|field|medical_desk|client", "risk": "low|medium|high", "risk_reason": "short", "patient_message_hint": "which approved template fits next, if any"}` }], { system: SYSTEM });
  const brief = { ...out, generated_at: new Date().toISOString() };
  const { changed } = await asSystem(sql, (tx) => tx`update cases set ai_brief = ${tx.json(brief)} where id = ${caseId}`);
  return { brief, changed };
}

// ---- 3. Natural-language command bar -> structured filter / navigation
export async function command(env: Env, q: string, role: string) {
  return gemini(env, [{ text: `User role: ${role}. Today is ${new Date().toISOString().slice(0, 10)} (IST). Convert the request into JSON.
Request: "${q.replace(/"/g, "'")}"
Schema: {"action":"filter_cases"|"navigate"|"new_enquiry"|"search","route":"one of /, /console, /cases, /patients, /calls, /callbacks, /approvals, /escalations, /complaints, /field, /mis, /audit, /settings","filters":{"stage":[...enquiry|pricing|booking|deployment|completion|payment|closure|closed|cancelled],"priority":"routine|urgent","sla_state":"ok|at_risk|breached","zone":"zone name","channel":"phone|whatsapp|email|chat","from":"YYYY-MM-DD","to":"YYYY-MM-DD","text":"free text"},"explain":"what you understood, 1 short line"}
Omit filters you do not need.` }], { system: SYSTEM, temperature: 0 });
}

// ---- 4. Free text (WhatsApp / email / notes) -> enquiry form fields
export async function extractEnquiry(env: Env, sql: Sql, userId: string, text: string) {
  const services = await readAsUser(sql, userId, (tx) => tx`select id::text, code, name from services where active`);
  const out = await gemini(env, [{ text: `Extract a home-care enquiry from this message. Text:\n"""${text}"""\n
Return JSON {"patient":{"full_name","age","gender","mobile","address","locality","pincode","landmark"},"caller_name","caller_relation","service_codes":[only from ${services.map((s) => s.code).join(', ')}],"preferred_slot_iso":"ISO in +05:30 or null","priority":"routine|urgent","clinical_red_flag":"string or null","missing":["fields still needed"]}` }], { system: SYSTEM, temperature: 0 });
  out.service_ids = (out.service_codes || []).map((c: string) => services.find((s) => s.code === c)?.id).filter(Boolean);
  return out;
}

// ---- 5. MIS narrative for management
export async function misNarrative(env: Env, period: string, data: unknown) {
  return gemini(env, [{ text: `Write a ${period} MIS commentary (max 120 words, plain sentences, no bullet symbols, no emojis) for Hinduja Home Care management from this JSON. Lead with SLA compliance and conversion, then exceptions that need attention, then one recommendation.\n${JSON.stringify(data).slice(0, 12000)}` }], { json: false, system: SYSTEM, temperature: 0.3 });
}
