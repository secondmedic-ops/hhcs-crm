// Telephony and patient messaging actions that need server secrets.
//   dial       click-to-call: the number is looked up here and never reaches the agent's browser (agents see masked numbers)
//   recording  proxied audio, every play written to the access log
//   quote / message  approved templates only, delivered on WhatsApp through MyOperator
import type { Ctx } from '../api/context';
import { ApiError } from '../domain/errors';
import { asSystem, asUser, normMobile, readAsUser } from '../db';
import { clickToCall, recordingUrl, sendWhatsApp } from './myoperator';
import { missingCallingSettings, moEnv } from './myoperator-config';
import { dbMessage } from './data';
import { isAddress, safeSmtpError, sendMail, smtpReady, SmtpError } from './smtp';

type J = Record<string, any>;
const wrap = (e: unknown): never => { throw dbMessage(e) ?? e; };

export async function dial(c: Ctx, body: J) {
  const ws = c.user.workspaceId;
  if (['case_id', 'patient_id', 'callback_id', 'number'].filter((k) => body[k]).length !== 1) {
    throw new ApiError(400, 'Choose one patient, case or callback to call');
  }
  if (body.number && c.user.role === 'agent') throw new ApiError(400, 'Choose a patient, case or callback to call');
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

  // Validate before changing a callback or creating a call. Legacy dial_mode settings are ignored.
  const env = await moEnv(c.env, c.sql);
  const missing = missingCallingSettings(env);
  if (missing.length) throw new ApiError(503, 'Calling is not configured. Ask your administrator to complete Settings > Telephony: ' + missing.join(', '));
  // Read the link fresh: the login cache lives 60 s per Worker instance, so a just-linked agent would be refused
  // and a just-unlinked one could still dial with the old MyOperator id.
  const [link] = await c.sql`select myoperator_user_id from profiles where id = ${c.user.id}::uuid and active`;
  const myoperatorUserId: string | null = link?.myoperator_user_id?.trim() || null;
  if (!myoperatorUserId) throw new ApiError(409, 'Your CRM login is not linked to a MyOperator agent. Ask your administrator to link it in Settings > Telephony.');

  const ref = 'crm-' + crypto.randomUUID();
  const { result, changed } = await asSystem(c.sql, async (tx) => {
    const [agent] = await tx`select id from profiles where id = ${c.user.id}::uuid and workspace_id = ${ws}::uuid and active for update`;
    if (!agent) throw new ApiError(409, 'Your agent account is inactive');
    const [active] = await tx`select id from calls where agent_id = ${c.user.id}::uuid and status in ('ringing','answered') limit 1`;
    if (active) throw new ApiError(409, 'You already have an active or unconfirmed call. Wait for its outcome before dialling again.');
    let number: string | null = null, patientId: string | null = body.patient_id || null, caseId: string | null = body.case_id || null;
    if (caseId) {
      const [k] = await tx`select c.patient_id, c.caller_mobile, p.mobile from cases c join patients p on p.id = c.patient_id
        where c.id = ${caseId} and c.workspace_id = ${ws}`;
      if (!k) return null;
      patientId = k.patient_id; number = body.use_caller && k.caller_mobile ? k.caller_mobile : k.mobile;
    } else if (body.callback_id) {
      // a pending callback, or an unreachable one the agent tries again (it reopens; a failed attempt goes through callback_retry)
      const [cb] = await tx`update callbacks set status = 'in_progress', assigned_to = ${c.user.id}, last_attempt_at = now(),
          attempts = attempts + 1, next_attempt_at = null, auto_dialled = false, completed_at = null, completed_by = null
        where id = ${body.callback_id} and workspace_id = ${ws} and status in ('pending', 'unreachable') returning number, patient_id`;
      if (!cb) throw new ApiError(409, 'Callback is already being dialled or is no longer in the queue');
      number = cb.number; patientId = cb.patient_id;
    } else if (patientId) {
      const [p] = await tx`select mobile from patients where id = ${patientId} and workspace_id = ${ws}`;
      number = p?.mobile ?? null;
    } else if (body.number && c.user.role !== 'agent') {
      number = normMobile(body.number);
    }
    if (!number) return null;
    const [call] = await tx`insert into calls (workspace_id, direction, customer_number, agent_id, agent_name, status, patient_id, case_id, session_id, click_to_call_ref, callback_id)
      values (${ws}, 'outbound', ${number}, ${c.user.id}, ${c.user.fullName}, 'ringing', ${patientId}, ${caseId}, ${ref}, ${ref}, ${body.callback_id || null}) returning id`;
    return { callId: call.id as string, number };
  });
  if (!result) throw new ApiError(400, 'No number to dial');
  c.changed.push(...changed);

  try {
    await clickToCall(env, { myoperatorUserId, number: result.number, referenceId: ref });
    // Return only CRM identifiers: provider responses can echo the customer's number or credentials.
    return { ok: true, mode: 'api', call_id: result.callId };
  } catch (e) {
    const unconfirmed = e instanceof ApiError && e.status === 504;
    const failure = await asSystem(c.sql, async (tx) => {
      // A webhook may already have advanced this call; never overwrite it with an HTTP failure.
      const updated = await tx`update calls set status = ${unconfirmed ? 'ringing' : 'failed'},
        ended_at = ${unconfirmed ? null : new Date().toISOString()},
        raw = coalesce(raw, '{}'::jsonb) || ${tx.json({ dial_outcome: unconfirmed ? 'unconfirmed' : 'rejected' })}
        where id = ${result.callId} and status = 'ringing' and session_id = ${ref} returning id`;
      if (!unconfirmed && updated.length && body.callback_id) {
        await tx`select callback_retry(${body.callback_id}::uuid, 'MyOperator rejected the dial')`;
      }
    });
    c.changed.push(...failure.changed);
    throw e;
  }
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

/** E-mail template -> the patient's address on the case, through Gmail SMTP. "accepted" is not proof of inbox delivery. */
async function deliverEmail(c: Ctx, caseId: string, out: { text: string; subject?: string | null }) {
  if (!smtpReady(c.env)) return { skipped: 'Outbound e-mail is not configured' };
  const to = await readAsUser(c.sql, c.user.id, async (tx) => {
    const [k] = await tx`select p.email from cases c join patients p on p.id = c.patient_id where c.id = ${caseId}`; // RLS decides visibility
    return String(k?.email || '').trim();
  }).catch(wrap);
  if (!to || !isAddress(to)) return { skipped: 'No valid e-mail address on the patient' };
  let meta: J;
  try {
    const r = await sendMail(c.env, { to: [to], subject: out.subject || 'Hinduja Home Care Services', text: out.text });
    meta = { delivery_status: 'accepted', via: 'smtp', attempts: r.attempts };
  } catch (e) {
    meta = { delivery_status: e instanceof SmtpError && e.ambiguous ? 'unknown' : 'failed', via: 'smtp', error: safeSmtpError(e) };
  }
  const { changed } = await asSystem(c.sql, (tx) => tx`update interactions set meta = coalesce(meta, '{}'::jsonb) || ${tx.json(meta)}
    where id = (select id from interactions where case_id = ${caseId}::uuid and channel = 'email' and direction = 'outbound' order by occurred_at desc limit 1)`);
  c.changed.push(...changed);
  return meta.delivery_status === 'accepted' ? { accepted: true, note: 'Accepted by Gmail for delivery (not proof of inbox delivery)' } : { error: meta.error, status: meta.delivery_status };
}

async function deliver(c: Ctx, caseId: string, out: { text: string; channel: string; provider_template_name?: string | null; subject?: string | null }) {
  if (out.channel === 'email') return deliverEmail(c, caseId, out);
  if (out.channel !== 'whatsapp') return { skipped: `${out.channel} delivery handled by mailbox / SMS gateway` };
  try {
    const [k] = await c.sql`select c.caller_mobile, p.mobile from cases c join patients p on p.id = c.patient_id where c.id = ${caseId}`;
    const to = k?.caller_mobile || k?.mobile;
    if (!to) return { skipped: 'No mobile number on the case' };
    const res = await sendWhatsApp(c.env, { to, text: out.text, templateName: out.provider_template_name }, c.sql);
    if ((res as J)?.queued) {
      await c.sql`update interactions set meta = coalesce(meta, '{}'::jsonb) || '{"delivery_status":"queued","via":"qr"}'::jsonb
        where id = (select id from interactions where case_id = ${caseId}::uuid and channel = 'whatsapp' and direction = 'outbound' order by occurred_at desc limit 1)`;
    }
    return res;
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
  return { text: m.text, delivery: await deliver(c, caseId, { text: m.text, channel: m.t.kind, provider_template_name: m.t.provider_template_name, subject: m.t.title }) };
}

export async function sendWhatsAppChat(c: Ctx, body: J) {
  const reqCaseId = body.case_id ? String(body.case_id) : null;
  let reqPatientId = body.patient_id ? String(body.patient_id) : null;
  const rawMobile = body.mobile ? normMobile(body.mobile) : null;
  const rawName = typeof body.patient_name === 'string' ? body.patient_name.trim() : '';
  const templateId = body.template_id ? String(body.template_id) : null;
  const rawText = typeof body.text === 'string' ? body.text.trim() : '';

  if (!reqCaseId && !reqPatientId && !rawMobile) throw new ApiError(400, 'Choose a patient, case or mobile number to message');
  if (!templateId && !rawText) throw new ApiError(400, 'Write a reply or choose an approved WhatsApp template');
  if (rawText.length > 4000) throw new ApiError(400, 'WhatsApp message cannot exceed 4,000 characters');

  if (!reqCaseId && !reqPatientId && rawMobile) {
    const { result: pid, changed: pChanged } = await asSystem(c.sql, async (tx) => {
      const [r] = await tx`select upsert_patient(${tx.json({
        workspace_id: c.user.workspaceId,
        full_name: rawName || 'WhatsApp contact',
        mobile: rawMobile,
      })}) as id`;
      return String(r.id);
    }).catch(wrap);
    c.changed.push(...pChanged);
    reqPatientId = pid;
  }

  const m = await readAsUser(c.sql, c.user.id, async (tx) => {
    let caseId = reqCaseId;
    let patientId = reqPatientId;
    let wsId = c.user.workspaceId;

    if (caseId) {
      const [k] = await tx`select id::text, workspace_id::text, patient_id::text from cases where id = ${caseId}`;
      if (!k) throw new ApiError(404, 'Case not found');
      wsId = k.workspace_id;
      patientId = k.patient_id;
    } else if (patientId) {
      const [p] = await tx`select id::text, workspace_id::text, full_name from patients where id = ${patientId}`;
      if (!p) throw new ApiError(404, 'Patient not found');
      wsId = p.workspace_id;
      const [openCase] = await tx`select id::text from cases where patient_id = ${patientId} and stage not in ('closed','cancelled') order by created_at desc limit 1`;
      if (openCase) caseId = openCase.id;
    }

    let t: J | null = null;
    let text = rawText;
    if (templateId) {
      const [tpl] = await tx`select id::text, code, title, kind, body, provider_template_name from templates where id = ${templateId} and status = 'approved'`;
      if (!tpl || tpl.kind !== 'whatsapp') throw new ApiError(400, 'Only approved WhatsApp templates can be sent here');
      t = tpl;
      if (caseId) {
        const [r] = await tx`select render_template(${tpl.id}, ${caseId}) as text`;
        text = String(r.text || '').trim();
      } else {
        const [p] = await tx`select full_name from patients where id = ${patientId}`;
        const [w] = await tx`select brand_name, support_number from workspaces where id = ${wsId}`;
        text = String(tpl.body || '')
          .replace(/\{\{patient_name\}\}/g, p?.full_name || '')
          .replace(/\{\{caller_name\}\}/g, p?.full_name || '')
          .replace(/\{\{brand\}\}/g, w?.brand_name || '')
          .replace(/\{\{support_number\}\}/g, w?.support_number || '');
      }
    }

    const summary = t ? `${t.title} sent (template ${t.code})` : 'WhatsApp reply sent';
    return { wsId, caseId, patientId: patientId!, t, text, summary };
  }).catch(wrap);

  let delivery: J;
  try {
    const [target] = await c.sql`
      select p.mobile, (select caller_mobile from cases where id = ${m.caseId} limit 1) as caller_mobile
      from patients p where p.id = ${m.patientId} and p.workspace_id = ${m.wsId}`;
    const to = target?.mobile || target?.caller_mobile;
    if (!to) delivery = { skipped: 'No mobile number on the patient' };
    else delivery = await sendWhatsApp(c.env, { to, text: m.text, templateName: m.t?.provider_template_name }, c.sql);
  } catch (e) {
    delivery = { error: (e as Error).message };
  }

  const msgId = delivery?.id || delivery?.message_id || delivery?.data?.id || null;
  const status = delivery?.error ? 'failed' : delivery?.queued ? 'queued' : delivery?.skipped ? 'logged' : 'sent';
  const { result: inserted, changed } = await asSystem(c.sql, async (tx) => {
    const [row] = await tx`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body, evidence, template_id, meta)
      values (${m.wsId}, ${m.caseId}, ${m.patientId}, 'whatsapp', 'outbound', ${c.user.id}, ${c.user.agentCode || c.user.fullName},
        ${m.summary}, ${m.text}, 'Message copy', ${m.t?.id ?? null}, ${tx.json({ message_id: msgId, delivery_status: status, via: delivery?.via || 'waba' })})
      returning id::text, occurred_at`;
    return row;
  });
  c.changed.push(...changed);
  return { id: inserted.id, occurred_at: inserted.occurred_at, text: m.text, case_id: m.caseId, patient_id: m.patientId, delivery };
}

