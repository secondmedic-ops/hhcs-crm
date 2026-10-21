// Email page (21 Oct 2026): send an e-mail to a patient through the Gmail SMTP sender (services/smtp.ts) and keep
// the copy on the patient's timeline (interactions, channel 'email', outbound), like WhatsApp replies in calls.ts.
// Inbound mail arrives through services/email.ts on the same channel; v_email_threads groups both per patient.
//   - access to the case / patient is checked as the user (readAsUser: RLS), then the mail is sent and logged;
//   - the case number goes into the subject, so a reply that reaches CareDesk lands on the same case;
//   - a typed address is saved on the patient only when the patient has none;
//   - a failed or unconfirmed send is logged with its status, never retried automatically.
import type { Ctx } from '../api/context';
import { ApiError } from '../domain/errors';
import { asSystem, readAsUser } from '../db';
import { dbMessage } from './data';
import { isAddress, safeSmtpError, sendMail, smtpReady, SmtpError } from './smtp';

type J = Record<string, any>;
const wrap = (e: unknown): never => { throw dbMessage(e) ?? e; };
const CASE_REF = /[A-Z]{2,5}-\d{6}-\d{5}/;
const escHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export async function sendEmailChat(c: Ctx, body: J) {
  const reqCaseId = body.case_id ? String(body.case_id) : null;
  const reqPatientId = body.patient_id ? String(body.patient_id) : null;
  const typedTo = typeof body.to === 'string' ? body.to.trim().toLowerCase() : '';
  const templateId = body.template_id ? String(body.template_id) : null;
  let subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  let text = typeof body.text === 'string' ? body.text.trim() : '';

  if (!reqCaseId && !reqPatientId) throw new ApiError(400, 'Choose a patient or case to e-mail');
  if (typedTo && !isAddress(typedTo)) throw new ApiError(400, 'That e-mail address is not valid');
  if (/[\r\n]/.test(subject)) throw new ApiError(400, 'The subject cannot contain a line break');
  if (subject.length > 200) throw new ApiError(400, 'The subject cannot exceed 200 characters');
  if (text.length > 20000) throw new ApiError(400, 'The e-mail cannot exceed 20,000 characters');
  if (!templateId && (!subject || !text)) throw new ApiError(400, 'Write a subject and a message, or choose an approved e-mail template');

  const m = await readAsUser(c.sql, c.user.id, async (tx) => {
    let caseId = reqCaseId;
    let patientId = reqPatientId;
    let caseNo: string | null = null;
    if (caseId) {
      const [k] = await tx`select id::text, patient_id::text, case_no from cases where id = ${caseId}`;
      if (!k) throw new ApiError(404, 'Case not found');
      patientId = k.patient_id; caseNo = k.case_no;
    }
    const [p] = await tx`select id::text, workspace_id::text, full_name, email from patients where id = ${patientId}`;
    if (!p) throw new ApiError(404, 'Patient not found');
    if (!caseId) {
      const [open] = await tx`select id::text, case_no from cases where patient_id = ${p.id} and stage not in ('closed','cancelled') order by created_at desc limit 1`;
      if (open) { caseId = open.id; caseNo = open.case_no; }
    }
    let tpl: J | null = null;
    if (templateId) {
      const [t] = await tx`select id::text, code, title, kind, body from templates where id = ${templateId} and status = 'approved'`;
      if (!t || t.kind !== 'email') throw new ApiError(400, 'Only approved e-mail templates can be sent here');
      tpl = t;
      if (!text) {
        if (caseId) { const [r] = await tx`select render_template(${t.id}, ${caseId}) as text`; text = String(r.text || '').trim(); }
        else text = String(t.body || '').replace(/\{\{(patient_name|caller_name)\}\}/g, p.full_name || '');
      }
      if (!subject) subject = String(t.title || '').trim();
    }
    return { wsId: p.workspace_id as string, patientId: p.id as string, patientEmail: (p.email || '').trim().toLowerCase(), caseId, caseNo, tpl };
  }).catch(wrap);

  const to = typedTo || m.patientEmail;
  if (!to) throw new ApiError(400, 'This patient has no e-mail address. Type the address to send to.');
  if (!subject || !text) throw new ApiError(400, 'The template has no subject or text for this case');
  if (m.caseNo && !CASE_REF.test(subject)) subject = `${subject} [${m.caseNo}]`;

  let status = 'sent', error: string | null = null;
  if (!smtpReady(c.env)) { status = 'logged'; error = 'E-mail is not configured (Settings > Telephony > Outbound e-mail)'; }
  else {
    try {
      const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1b1d1c">${escHtml(text).replace(/\n/g, '<br>')}</div>`;
      await sendMail(c.env, { to: [to], subject, text, html, replyTo: c.env.EMAIL_REPLY_TO });
    } catch (e) {
      status = e instanceof SmtpError && e.ambiguous ? 'unknown' : 'failed';
      error = safeSmtpError(e);
    }
  }

  const { result: row, changed } = await asSystem(c.sql, async (tx) => {
    // a typed address becomes the patient's e-mail only when none is on file (never overwrites)
    if (typedTo && !m.patientEmail && status !== 'failed') await tx`update patients set email = ${typedTo} where id = ${m.patientId} and coalesce(email, '') = ''`;
    const [r] = await tx`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_id, actor_label, summary, body, evidence, template_id, meta)
      values (${m.wsId}, ${m.caseId}, ${m.patientId}, 'email', 'outbound', ${c.user.id}, ${c.user.agentCode || c.user.fullName},
        ${`Email: ${subject}`}, ${text}, 'Mail copy', ${m.tpl?.id ?? null}, ${tx.json({ subject, to, delivery_status: status, error })})
      returning id::text, occurred_at`;
    return r;
  });
  c.changed.push(...changed);
  return { id: row.id, occurred_at: row.occurred_at, case_id: m.caseId, patient_id: m.patientId, subject, to, delivery: { status, error } };
}
