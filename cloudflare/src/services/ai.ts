// AI layer (Google Gemini; key, model and the auto-summary switch from Settings or the Worker secret, see ai-config.ts).
// Every output is advisory: it fills drafts, flags risk and scores QA, but prices, stage changes and patient messages
// still go through the locked workflow.
import { asSystem, connect, pgArray, readAsUser, type Sql } from '../db';
import type { Env } from '../env';
import type { Ctx } from '../api/context';
import { ApiError } from '../domain/errors';
import { recordingUrl } from './myoperator';
import { moEnv } from './myoperator-config';
import { aiEnv, aiPause, autoSummaries, setAiPause, AI_DEFAULT_MODEL } from './ai-config';
import { notifyLive } from './live';

type J = Record<string, any>;
const MODEL = (env: Env) => env.GEMINI_MODEL || AI_DEFAULT_MODEL;
const BASE = (env: Env) => (env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NOT_CONFIGURED = 'AI is not configured: add the Gemini API key in Settings > Telephony & integrations';

/** Gemini refused for a reason about the key or the Google account, not about the call: quota, billing, invalid key,
 *  overload. Automatic summaries pause for `retryAfterS` and the call keeps its attempts. */
export class GeminiLimitError extends Error {
  constructor(message: string, public retryAfterS: number) { super(message); }
}

/** A short, readable error from a Gemini answer (Google's quota text is long and its key detail sits at the end). */
async function geminiError(res: Response, what: string): Promise<Error> {
  const t = await res.text().catch(() => '');
  let e: J = {};
  try { e = JSON.parse(t).error || {}; } catch { e = {}; }
  const msg = String(e.message || `HTTP ${res.status} ${t.slice(0, 120)}`);
  const details: J[] = Array.isArray(e.details) ? e.details : [];
  const delay = details.find((d) => /RetryInfo/.test(d['@type'] || ''))?.retryDelay;
  const retryS = delay ? Math.ceil(parseFloat(String(delay))) || null : null;
  if (res.status === 429 || e.status === 'RESOURCE_EXHAUSTED') {
    const v = details.find((d) => /QuotaFailure/.test(d['@type'] || ''))?.violations?.[0] || {};
    const metric = String(v.quotaId || v.quotaMetric || msg.match(/Quota exceeded for metric: ([^\s,]+)/)?.[1] || '');
    const limit = v.quotaValue ?? msg.match(/limit: (\d+)/)?.[1];
    const free = /free.?tier/i.test(metric + ' ' + msg);
    const perMinute = /PerMinute|per_minute/i.test(metric);
    const text = `Gemini quota exceeded${metric ? ` (${metric.replace(/^generativelanguage\.googleapis\.com\//, '')}${limit != null ? `, limit ${limit}` : ''})` : ''}. `
      + (free ? 'The key is on Google\'s free tier: turn on billing for its Google Cloud project in Google AI Studio, or use a key from a billed project.'
        : 'Wait for the quota to reset, or raise it in Google AI Studio.');
    return new GeminiLimitError(text, retryS ?? (perMinute ? 60 : 30 * 60));
  }
  if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/.test(t)) {
    return new GeminiLimitError(`Gemini refused the key: ${msg.slice(0, 160)}`, 30 * 60);
  }
  if (res.status === 500 || res.status === 503) return new GeminiLimitError(`Gemini is unavailable right now (${msg.slice(0, 120)})`, retryS ?? 5 * 60);
  return new Error(`${what}: ${msg.slice(0, 240)}`);
}

/** One Gemini call. The key goes in a header, never in the URL (URLs end up in logs). */
export async function gemini(env: Env, parts: J[], o: { json?: boolean; temperature?: number; system?: string } = {}): Promise<any> {
  const json = o.json ?? true;
  if (!env.GEMINI_API_KEY) throw new ApiError(503, NOT_CONFIGURED);
  const res = await fetch(`${BASE(env)}/v1beta/models/${MODEL(env)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: o.system ? { parts: [{ text: o.system }] } : undefined,
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: o.temperature ?? 0.2, ...(json ? { responseMimeType: 'application/json' } : {}) },
    }),
  });
  if (!res.ok) throw await geminiError(res, 'Gemini');
  const j = (await res.json()) as J;
  const text = j.candidates?.[0]?.content?.parts?.map((p: J) => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned no text' + (j.candidates?.[0]?.finishReason ? ` (${j.candidates[0].finishReason})` : ''));
  return json ? JSON.parse(text.replace(/^```json\s*|```$/g, '')) : text;
}

/** Hands the audio to Gemini's Files API as raw bytes. No base64 in the Worker: encoding a recording in JavaScript costs
 *  more CPU than the Workers free plan allows (10 ms), while passing the downloaded buffer on is done by the runtime. */
async function uploadAudio(env: Env, buf: ArrayBuffer, mime: string, name: string): Promise<{ name: string; uri: string; mimeType: string }> {
  const key = env.GEMINI_API_KEY!;
  const start = await fetch(`${BASE(env)}/upload/v1beta/files`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(buf.byteLength), 'X-Goog-Upload-Header-Content-Type': mime, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: name } }),
  });
  const url = start.headers.get('x-goog-upload-url');
  if (!start.ok) throw await geminiError(start, 'Gemini upload');
  if (!url) throw new Error('Gemini upload: no upload address');
  const up = await fetch(url, { method: 'POST', headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: buf });
  if (!up.ok) throw await geminiError(up, 'Gemini upload');
  let f = ((await up.json()) as J).file as J;
  // audio is usually ACTIVE at once; wait up to ~20 s while Gemini still processes it
  for (let i = 0; f?.state === 'PROCESSING' && i < 10; i++) {
    await sleep(2000);
    const r = await fetch(`${BASE(env)}/v1beta/${f.name}`, { headers: { 'x-goog-api-key': key } });
    if (r.ok) f = (await r.json()) as J;
  }
  if (!f?.uri) throw new Error('Gemini upload: no file reference returned');
  if (f.state === 'FAILED') throw new Error('Gemini could not read the recording');
  return { name: f.name, uri: f.uri, mimeType: f.mimeType || mime };
}

/** The recording is removed from Gemini as soon as the summary is back (it would otherwise stay up to 48 hours). */
async function deleteFile(env: Env, name: string) {
  await fetch(`${BASE(env)}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': env.GEMINI_API_KEY! } }).catch(() => {});
}

const SYSTEM = `You support the Hinduja Home Care Services contact centre run by SecondMedic in Mumbai (MMR).
Services: home sample collection, portable X-ray, 12-lead ECG at home, and post-discharge home care through partners
(nurses, attendants, ICU and hospital beds, oxygen and other equipment). Callers speak English, Hindi or Marathi.
Never give clinical advice. Never invent prices; prices come only from the rate card. Be concise and factual.`;

const SHORT_CALL_S = 10;     // shorter answered calls are not worth a summary
// longer ones are left to a person: 32 audio tokens a second, so 2 hours is ~230,000 tokens (Google's free-tier limit is
// 250,000 a minute; no request may carry more than 9.5 hours of audio). A very long call is usually a wrong duration.
const LONG_CALL_S = 2 * 3600;
const MAX_AUDIO = 60 * 1024 * 1024;

// ---- 1. Call intelligence: transcript, summary, sentiment, enquiry extraction, QA score, red flags
/** Summarises one recorded call. Marks the call processing / done / failed (with the reason) so the screens show where it
 *  stands and the cron sweep can retry. Pass `sql` to reuse a connection (it is then left open). */
export async function processCall(env0: Env, callId: string, exec?: ExecutionContext, o: { sql?: Sql } = {}) {
  const sql = o.sql ?? connect(env0);
  const changed = new Set<string>();
  const live = () => { if (exec && changed.size) notifyLive(env0, exec, [...changed]); changed.clear(); };
  try {
    const env = await aiEnv(env0, sql);
    if (!env.GEMINI_API_KEY) throw new ApiError(503, NOT_CONFIGURED);
    // claim the call, so the webhook, the cron and a person pressing "Summarise" never work on it at the same time
    const claim = await asSystem(sql, (tx) => tx`update calls set ai_status = 'processing', ai_started_at = now(), ai_attempts = ai_attempts + 1, ai_error = null
      where id = ${callId} and recording_filename is not null
        and (ai_status is distinct from 'processing' or ai_started_at < now() - interval '10 minutes') returning *`);
    claim.changed.forEach((t) => changed.add(t));
    const call = claim.result[0];
    if (!call) {
      const [c] = await sql`select recording_filename from calls where id = ${callId}`;
      throw new ApiError(c?.recording_filename ? 409 : 400, !c ? 'Call not found' : !c.recording_filename ? 'No recording on this call' : 'This call is already being summarised');
    }
    live();
    try {
      const link = await recordingUrl(await moEnv(env, sql), call.recording_filename);
      const audio = await fetch(link);
      if (!audio.ok) throw new Error(`Could not download the recording (HTTP ${audio.status})`);
      const type = audio.headers.get('content-type')?.split(';')[0]?.trim() || '';
      const mime = type.startsWith('audio/') ? type : 'audio/mpeg';
      const buf = await audio.arrayBuffer();
      if (!buf.byteLength) throw new Error('The recording file is empty');
      if (buf.byteLength > MAX_AUDIO) throw new Error('Recording too large to summarise (over 60 MB)');
      const services = await sql`select code, name from services where workspace_id = ${call.workspace_id} and active`;
      const [script] = await sql`select body from templates where workspace_id = ${call.workspace_id} and code = 'S-01' and status = 'approved' limit 1`;

      const file = await uploadAudio(env, buf, mime, `call-${callId}`);
      let out: J;
      try {
        out = await gemini(env, [
          { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
          { text: `Analyse this recorded ${call.direction} call between a contact-centre agent and a caller.
Return JSON with keys:
transcript (string, speaker-labelled "Agent:"/"Caller:", translated to English if needed),
language (string),
summary (2-4 sentences in English for the patient record: who called and for whom, what they need, what was agreed or promised, and any follow-up with its time),
next_action (one short imperative line for the team, or null),
intent (one of: new_booking, reschedule, cancellation, report_query, complaint, price_enquiry, emergency, other),
sentiment (positive|neutral|negative|distressed),
extracted {patient_name, age, gender (M/F/O), caller_name, caller_relation, address, locality, pincode, preferred_slot_text, service_codes (array, only from: ${services.map((s) => s.code + '=' + s.name).join('; ')}), urgent (bool)},
consent_given (bool),
flags (array of short strings: e.g. "chest pain mentioned", "price quoted off rate card", "consent not taken", "angry caller"),
qa {greeting, consent, price_accuracy, empathy, closure} each 0-5, scored against this approved script:
${script?.body || 'Greeting, consent, accurate price, empathy, clear closure.'}
qa_notes (one sentence of coaching for the agent).` },
        ], { system: SYSTEM });
      } finally {
        await deleteFile(env, file.name);
      }
      if (!out?.summary) throw new Error('Gemini returned no summary');

      const q = out.qa || {};
      const total = ['greeting', 'consent', 'price_accuracy', 'empathy', 'closure'].reduce((s, k) => s + (Number(q[k]) || 0), 0);
      const done = await asSystem(sql, async (tx) => {
        await tx`update calls set transcript = ${out.transcript ?? null}, ai_summary = ${out.summary ?? null}, ai_sentiment = ${out.sentiment ?? null},
          ai_intent = ${out.intent ?? null}, ai_extracted = ${tx.json({ ...(out.extracted || {}), consent_given: out.consent_given, language: out.language, next_action: out.next_action ?? null })},
          ai_flags = ${pgArray((out.flags || []).map(String))}::text[], ai_processed_at = now(), ai_status = 'done', ai_error = null where id = ${callId}`;
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
      done.changed.forEach((t) => changed.add(t));
      return out;
    } catch (e) {
      const msg = String((e as Error).message || e).slice(0, 300);
      // a quota / billing / key problem is not the call's fault: it keeps its attempt, and automatic summaries pause
      const limit = e instanceof GeminiLimitError;
      const failed = await asSystem(sql, (tx) => tx`update calls set ai_status = 'failed', ai_error = ${msg},
        ai_attempts = case when ${limit} then greatest(ai_attempts - 1, 0) else ai_attempts end where id = ${callId}`).catch(() => null);
      failed?.changed.forEach((t) => changed.add(t));
      if (limit) await setAiPause(sql, (e as GeminiLimitError).retryAfterS, msg).catch(() => {});
      throw e;
    }
  } finally {
    live();
    if (!o.sql) await sql.end({ timeout: 2 }).catch(() => {});
  }
}

/** "Summarise" on a call: only a call this user can see (RLS), with a clear message when it fails. */
export async function summariseCall(c: Ctx, callId: string) {
  const [seen] = await readAsUser(c.sql, c.user.id, (tx) => tx`select id from calls where id = ${callId}`);
  if (!seen) throw new ApiError(404, 'Call not found');
  try {
    return await processCall(c.env, callId, c.exec, { sql: c.sql });
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(502, 'AI summary failed: ' + String((e as Error).message || e).slice(0, 300));
  }
}

/** Whether summaries are on, for the screens (no key or settings returned). */
export async function aiStatus(c: Ctx) {
  const env = await aiEnv(c.env, c.sql);
  return { enabled: !!env.GEMINI_API_KEY, auto: autoSummaries(env) };
}

/** Right after a webhook ends a recorded call. Does nothing when AI or auto-summaries are off. */
export async function summariseIfEnabled(env0: Env, callId: string, exec: ExecutionContext) {
  const sql = connect(env0);
  try {
    if (!autoSummaries(await aiEnv(env0, sql))) return;
    await processCall(env0, callId, exec, { sql });
  } catch (e) {
    console.log('ai call', (e as Error).message);
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

/** Every minute (cron): one recorded call without a summary, newest first, from the last 14 days. Catches calls brought in
 *  by the call-log sync, recordings that arrived after the call ended, and failures (up to 3 attempts, 10 minutes apart). */
export async function summariseBacklog(env0: Env, sql: Sql, exec: ExecutionContext): Promise<J> {
  const env = await aiEnv(env0, sql);
  if (!autoSummaries(env)) return { skipped: env.GEMINI_API_KEY ? 'Auto-summaries off' : 'No Gemini key' };
  const pause = await aiPause(sql);
  if (pause) return { skipped: 'Paused until ' + pause.paused_until };
  const short = await asSystem(sql, (tx) => tx`update calls set ai_status = 'skipped',
        ai_error = case when talk_seconds < ${SHORT_CALL_S} then ${`Under ${SHORT_CALL_S} seconds of talk time`}
          else ${`Over ${LONG_CALL_S / 3600} hours of talk time: check the call length, then use Summarise now if it is right`} end
    where recording_filename is not null and ai_processed_at is null and ai_status is null
      and talk_seconds is not null and (talk_seconds < ${SHORT_CALL_S} or talk_seconds > ${LONG_CALL_S}) and started_at > now() - interval '14 days'`);
  if (short.changed.length) notifyLive(env0, exec, short.changed);
  const [next] = await sql`select id from calls
    where recording_filename is not null and ai_processed_at is null and started_at > now() - interval '14 days'
      and coalesce(ended_at, started_at) < now() - interval '1 minute'
      and (ai_status is null
           or (ai_status = 'failed' and ai_attempts < 3 and ai_started_at < now() - interval '10 minutes')
           or (ai_status = 'processing' and ai_started_at < now() - interval '10 minutes'))
    order by started_at desc limit 1`;
  if (!next) return { idle: true };
  try {
    await processCall(env0, next.id, exec, { sql });
    return { summarised: next.id };
  } catch (e) {
    return { failed: next.id, error: (e as Error).message };
  }
}

// ---- 2. Case brief + next best action (reads as the user, so they only brief cases they can see)
export async function caseBrief(env0: Env, sql: Sql, userId: string, caseId: string) {
  const env = await aiEnv(env0, sql);
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
export async function extractEnquiry(env0: Env, sql: Sql, userId: string, text: string) {
  const env = await aiEnv(env0, sql);
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
