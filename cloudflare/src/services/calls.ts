// Telephony and patient messaging actions that need server secrets.
//   dial       click-to-call: the number is looked up here and never reaches the agent's browser (agents see masked numbers)
//   recording  proxied audio, every play written to the access log
//   quote / message  approved templates only, delivered on WhatsApp through MyOperator
import type { Ctx } from '../api/context';
import { ApiError } from '../domain/errors';
import { asSystem, asUser, normMobile, readAsUser } from '../db';
import { clickToCall, recordingUrl, sendWhatsApp } from './myoperator';
import { moEnv } from './myoperator-config';
import { dbMessage } from './data';

type J = Record<string, any>;
const wrap = (e: unknown): never => { throw dbMessage(e) ?? e; };

export async function dial(c: Ctx, body: J) {
  const ws = c.user.workspaceId;
  // what the agent may dial is decided with their own visibility (RLS): a case or patient they can see, or a callback
  const target = await readAsUser(c.sql, c.user.id, async (tx) => {
    if (body.case_id) {
      const [k] = await tx`select id from cases where id = ${body.case_id}`;
      if (!k) return null;
    }
    if (body.patient_id) {
      const [p] = await tx`select id from patients where id = ${body.patient_id}`;
      if (!p) return null;
    }
    if (body.callback_id) {
      const [cb] = await tx`select id from callbacks where id = ${body.callback_id}`;
      if (!cb) return null;
    }
    return true;
  }).catch(wrap);
  if (!target) throw new ApiError(404, 'Not found or not yours to call');

  const ref = 'crm-' + crypto.randomUUID();
  const { result, changed } = await asSystem(c.sql, async (tx) => {
    let number: string | null = null, patientId: string | null = body.patient_id || null, caseId: string | null = body.case_id || null;
    if (caseId) {
      const [k] = await tx`select c.patient_id, c.caller_mobile, p.mobile from cases c join patients p on p.id = c.patient_id
        where c.id = ${caseId} and c.workspace_id = ${ws}`;
      if (!k) return null;
      patientId = k.patient_id; number = body.use_caller && k.caller_mobile ? k.caller_mobile : k.mobile;
    } else if (body.callback_id) {
      const [cb] = await tx`update callbacks set status = 'in_progress', assigned_to = ${c.user.id}, last_attempt_at = now()
        where id = ${body.callback_id} and workspace_id = ${ws} returning number, patient_id`;
      if (!cb) return null;
      number = cb.number; patientId = cb.patient_id;
    } else if (patientId) {
      const [p] = await tx`select mobile from patients where id = ${patientId} and workspace_id = ${ws}`;
      number = p?.mobile ?? null;
    } else if (body.number && c.user.role !== 'agent') {
      number = normMobile(body.number);
    }
    if (!number) return null;
    const [call] = await tx`insert into calls (workspace_id, direction, customer_number, agent_id, agent_name, status, patient_id, case_id, session_id, click_to_call_ref)
      values (${ws}, 'outbound', ${number}, ${c.user.id}, ${c.user.fullName}, 'ringing', ${patientId}, ${caseId}, ${ref}, ${ref}) returning id`;
    const [pt] = patientId ? await tx`select full_name from patients where id = ${patientId}` : [];
    return { callId: call.id as string, number, patientId, caseId, patientName: (pt?.full_name as string) || null };
  });
  if (!result) throw new ApiError(400, 'No number to dial');
  c.changed.push(...changed);

  // 1) MyOperator Calling API (rings the agent, then the patient) when it is fully set up
  const env = await moEnv(c.env, c.sql);
  const forceApp = String(env.MYOPERATOR_DIAL_MODE || '').trim().toLowerCase() === 'app';
  const apiReady = !!(env.MYOPERATOR_OBD_API_KEY && env.MYOPERATOR_COMPANY_ID && env.MYOPERATOR_PUBLIC_IVR_ID && c.user.myoperatorUserId);
  let apiError: string | null = null;
  if (!forceApp && apiReady) {
    try {
      const provider = await clickToCall(env, { myoperatorUserId: c.user.myoperatorUserId, number: result.number, referenceId: ref });
      return { ok: true, mode: 'api', call_id: result.callId, provider };
    } catch (e) {
      apiError = (e as Error).message;
    }
  }
  // 2) Otherwise: the agent dials through MyOperator (Chrome extension button on the number, or the MyOperator app).
  // The number is shown to this user only for this call (written to the access log); the call-log sync then attaches
  // MyOperator's call record, recording included, to this call / case (same number, within 3 hours).
  const reason = forceApp ? 'Outgoing calls are set to the MyOperator extension / app'
    : apiError ? `MyOperator Calling API refused: ${apiError.replace(/^MyOperator:\s*/, '')}`
      : 'MyOperator Calling API is not fully set up (Public IVR ID or your MyOperator user)';
  const r2 = await asSystem(c.sql, async (tx) => {
    await tx`insert into access_log (workspace_id, user_id, action, entity, entity_id, meta)
      values (${ws}::uuid, ${c.user.id}::uuid, 'reveal_number', ${result.caseId ? 'case' : 'patient'}, ${result.caseId || result.patientId}, ${tx.json({ purpose: 'dial via MyOperator app', call_id: result.callId })})`;
    if (result.caseId) {
      await tx`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, call_id, meta)
        values (${ws}::uuid, ${result.caseId}::uuid, ${result.patientId}, 'phone', 'outbound', ${c.user.id}::uuid, ${c.user.fullName}, 'Outbound call started via MyOperator (extension / app)', ${result.callId}::uuid, ${tx.json({ mode: 'app' })})`;
    }
    return null;
  });
  c.changed.push(...r2.changed);
  return { ok: true, mode: 'app', call_id: result.callId, number: result.number, patient_name: result.patientName, reason };
}

export async function recording(c: Ctx): Promise<Response> {
  const id = c.params.id;
  const call = await readAsUser(c.sql, c.user.id, async (tx) => {
    const [row] = await tx`select id, recording_filename from calls where id = ${id}`; // RLS decides visibility
    return row;
  }).catch(wrap);
  if (!call?.recording_filename) throw new ApiError(404, 'No recording');
  await asUser(c.sql, c.user.id, (tx) => tx`select log_access('play_recording', 'call', ${id}, '{}'::jsonb)`);
  const link = await recordingUrl(await moEnv(c.env, c.sql), call.recording_filename);
  const audio = await fetch(link);
  if (!audio.ok) throw new ApiError(502, 'Recording unavailable from MyOperator');
  return new Response(audio.body, { headers: { 'Content-Type': audio.headers.get('content-type') || 'audio/mpeg', 'Cache-Control': 'private, no-store' } });
}

async function deliver(c: Ctx, caseId: string, out: { text: string; channel: string; provider_template_name?: string | null }) {
  if (out.channel !== 'whatsapp') return { skipped: `${out.channel} delivery handled by mailbox / SMS gateway` };
  try {
    const [k] = await c.sql`select c.caller_mobile, p.mobile from cases c join patients p on p.id = c.patient_id where c.id = ${caseId}`;
    const to = k?.caller_mobile || k?.mobile;
    if (!to) return { skipped: 'No mobile number on the case' };
    return await sendWhatsApp(await moEnv(c.env, c.sql), { to, text: out.text, templateName: out.provider_template_name });
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export async function sendQuote(c: Ctx, body: J) {
  const caseId = c.params.id;
  const { result, changed } = await asUser(c.sql, c.user.id, async (tx) => {
    const [r] = await tx`select send_quote(${caseId}, ${body.template_id}) as r`;
    return r.r as J;
  }).catch(wrap);
  c.changed.push(...changed);
  return { ...result, delivery: await deliver(c, caseId, result as never) };
}

export async function sendMessage(c: Ctx, body: J) {
  const caseId = c.params.id;
  // rendered as the user (they must be able to see the case); the timeline entry is written by the system,
  // because users may only add notes to the timeline themselves
  const m = await readAsUser(c.sql, c.user.id, async (tx) => {
    const [t] = await tx`select id, code, title, kind, provider_template_name from templates where id = ${body.template_id} and status = 'approved'`;
    if (!t || t.kind === 'script') throw new ApiError(400, 'Only approved message templates can be sent');
    const [k] = await tx`select workspace_id, patient_id from cases where id = ${caseId}`;
    if (!k) throw new ApiError(404, 'Case not found');
    const [r] = await tx`select render_template(${t.id}, ${caseId}) as text`;
    return { t, k, text: r.text as string };
  }).catch(wrap);
  const { changed } = await asSystem(c.sql, (tx) => tx`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body, evidence, template_id)
    values (${m.k.workspace_id}, ${caseId}, ${m.k.patient_id}, ${m.t.kind}, 'outbound', ${c.user.id}, ${c.user.agentCode || c.user.fullName},
      ${`${m.t.title} sent (template ${m.t.code})`}, ${m.text}, 'Message copy', ${m.t.id})`);
  c.changed.push(...changed);
  return { text: m.text, delivery: await deliver(c, caseId, { text: m.text, channel: m.t.kind, provider_template_name: m.t.provider_template_name }) };
}
