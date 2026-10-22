import type { Tx } from '../db';

const REF = /\bFB-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i;
export function parseFeedbackReply(subject: string, text: string) {
  const reference = `${subject}\n${text}`.match(REF)?.[1] || null;
  // Email replies normally retain the private link in the quoted original. It proves possession, beyond From alone.
  const token = text.match(/\/feedback#([a-f0-9]{64})\b/i)?.[1] || null;
  const fresh = text.split(/^(?:\s*>|On .+wrote:|From:|[- ]*Original Message[- ]*)/im)[0]
    .replace(REF,'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').trim();
  const [first, ...rest] = fresh.split(/\r?\n/);
  const match = first?.match(/^(?:rating\s*:\s*)?([1-5])(?:\s*\/\s*5)?(?:[ \t]+(.+))?$/i);
  return { reference, token, rating: match ? Number(match[1]) : null,
    comment: match ? [match[2] || '', ...rest].join('\n').trim() : fresh };
}
export async function receiveFeedbackReply(tx: Tx, a: { workspace: string; channel: 'email'|'whatsapp'; sender: string; subject?: string; text: string; messageId?: string|null; contextText?: string }) {
  const p = parseFeedbackReply(a.subject || '', a.text);
  const context = a.contextText ? parseFeedbackReply('',a.contextText) : null;
  const reference = p.reference || context?.reference || null;
  if (p.rating == null && !reference && !p.token) return { handled: false };
  const hash = p.token ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(p.token))), b=>b.toString(16).padStart(2,'0')).join('') : null;
  // Tokens and quoted customer/medical content never enter interactions or error output.
  const comment = p.comment.replace(/https?:\/\/\S+/g,'[link removed]').replace(/[a-f0-9]{64}/gi,'[private code removed]');
  const [r] = await tx`select receive_feedback_reply(${a.workspace}::uuid,${a.channel},${a.sender},${reference}::uuid,${hash},${p.rating},${comment},${a.messageId?.slice(0,200) || null}) as r`;
  return r.r as { handled: boolean; status?: string };
}
