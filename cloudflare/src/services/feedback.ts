import type { Ctx } from '../api/context';
import type { Env } from '../env';
import { asSystem, asUser, connect, readAsUser, type Sql } from '../db';
import { ApiError } from '../domain/errors';
import { json, toResponse } from '../api/http';
import { notifyLive } from './live';
import { isAddress, safeSmtpError, sendMail, SmtpError } from './smtp';

const TOKEN = /^[a-f0-9]{64}$/;
export const hashFeedbackToken = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export function feedbackUrl(origin: string, token: string) {
  const url = new URL('/feedback', origin);
  if (url.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(url.hostname)) throw new ApiError(503, 'Secure feedback address is not configured');
  url.hash = token;
  return url.toString();
}
export function feedbackRequestText(id: string, experience: string, link: string, emailReply = false) {
  const question = experience === 'service' ? 'How would you rate the service delivered by Hinduja Home Care Services?' : 'How would you rate your recent call interaction with our team?';
  return `${question}\nPlease reply with Rating: 1 to Rating: 5 on the first line, followed by an optional comment.\nReference: FB-${id}\n${emailReply ? 'Keep the original message and private link quoted in your email reply.\n' : 'Quote this message when replying on WhatsApp, or include the reference.\n'}You can also submit here: ${link}\nPlease do not include medical details or personal information.`;
}

export async function issueFeedbackLink(c: Ctx, body: { request_id?: string }) {
  const id = body?.request_id;
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw new ApiError(400, 'Choose a feedback request');
  const visible = await readAsUser(c.sql, c.user.id, tx => tx`select id,experience from v_customer_feedback where id = ${id}::uuid`);
  if (!visible.length) throw new ApiError(404, 'Feedback request not found');
  const token = newToken();
  const hash = await hashFeedbackToken(token);
  const { result, changed } = await asUser(c.sql, c.user.id, tx => tx`select feedback_issue_link(${id}::uuid, ${hash}) as expires_at`);
  c.changed.push(...changed);
  const url = feedbackUrl(c.env.APP_URL || c.url.origin, token);
  return { url, expires_at: result[0].expires_at, message: feedbackRequestText(id,visible[0].experience,url) };
}

/** Capability-only endpoints: the token is in the POST body, never a path/query string or logs. */
export async function publicFeedback(req: Request, env: Env, exec: ExecutionContext, submit: boolean) {
  let sql: Sql | null = null;
  try {
    const length = Number(req.headers.get('content-length') || 0);
    if (length > 12000) throw new ApiError(400, 'Feedback is too long');
    const reader = req.body?.getReader();
    if (!reader) throw new ApiError(400, 'Malformed feedback request');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 12000) { await reader.cancel(); throw new ApiError(400, 'Feedback is too long'); }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body: any;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ApiError(400, 'Malformed feedback request'); }
    if (typeof body?.token !== 'string' || !TOKEN.test(body.token)) throw new ApiError(404, 'This feedback link is invalid');
    if (submit && (!Number.isInteger(body.rating) || body.rating < 1 || body.rating > 5)) throw new ApiError(400, 'Please select a rating from 1 to 5');
    if (submit && body.comment != null && (typeof body.comment !== 'string' || body.comment.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.comment))) throw new ApiError(400, 'Feedback must be plain text, up to 2,000 characters');
    const hash = await hashFeedbackToken(body.token);
    sql = connect(env);
    const { result, changed } = await asSystem(sql, async tx => {
      const [r] = await tx`select id, status, experience, expires_at <= now() as expired from feedback_requests where token_hash = ${hash} for update`;
      if (!r) throw new ApiError(404, 'This feedback link is invalid');
      if (r.status === 'submitted') throw new ApiError(409, 'Feedback has already been submitted using this link. Thank you');
      if (r.expired) throw new ApiError(410, 'This feedback link has expired. Please ask our team for a new link');
      if (submit) {
        await tx`insert into feedback_responses(request_id, rating, comment) values (${r.id}, ${body.rating}, ${body.comment?.trim() || null})`;
        await tx`update feedback_requests set status = 'submitted', submitted_at = now() where id = ${r.id}`;
      }
      return { ok: true, experience: r.experience };
    });
    if (changed.length) notifyLive(env, exec, changed);
    return json(result);
  } catch (e) {
    // Never pass database details, submitted text, or capability tokens to shared error logging.
    return toResponse(e instanceof ApiError ? e : new ApiError(503, 'Feedback is temporarily unavailable. Please try again'));
  } finally {
    if (sql) exec.waitUntil(sql.end({ timeout: 2 }).catch(() => {}));
  }
}

export interface FeedbackEmailClaim { id: string; email: string; token: string; experience?: string; reply_to?: string }
export async function deliverFeedbackEmail(env: Env, sql: Sql, claim: FeedbackEmailClaim, send: typeof sendMail = sendMail) {
  let status = 'accepted', error: string | null = null;
  try {
    if (!isAddress(claim.email)) throw new ApiError(400, 'Recipient address is invalid');
    const link = feedbackUrl(env.APP_URL || '', claim.token);
    await send(env, { to: [claim.email], subject: `Share Your Feedback · ${claim.experience === 'service' ? 'Service' : 'Call'} [FB-${claim.id}]`,
      replyTo: claim.reply_to && isAddress(claim.reply_to) ? claim.reply_to : env.EMAIL_REPLY_TO, text: feedbackRequestText(claim.id,claim.experience || 'call',link,true) });
  } catch (e) {
    status = e instanceof SmtpError && e.ambiguous ? 'unknown' : 'failed';
    error = safeSmtpError(e);
  }
  const { changed } = await asSystem(sql, tx => tx`update feedback_requests set delivery_status = ${status}, delivery_error = ${error}
    where id = ${claim.id}::uuid and delivery_status = 'sending'`);
  return { status, changed };
}
