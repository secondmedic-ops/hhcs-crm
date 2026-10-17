// Outbound e-mail through Gmail SMTP (smtp.gmail.com:465, implicit TLS, AUTH PLAIN) over Cloudflare TCP sockets
// (cloudflare:sockets connect() with secureTransport 'on'; the runtime verifies the server certificate, there is no
// switch to turn that off). Port 25 is blocked on Workers, 465 is allowed.
// - Safe errors: SmtpError carries the step and the SMTP code only, never the password, recipients or message.
// - Bounded retries: connection / timeout / 4xx failures before the message is handed over are retried (3 tries).
//   Once the final "." has been sent, a lost answer is NOT retried (the mail may already be queued): outcome 'unknown'.
// - "accepted" means Gmail accepted the message for delivery. It does not prove it reached an inbox.
// - Debug transcript (level 2) only when a caller asks for it; AUTH, addresses and the message body are redacted.
import type { Env } from '../env';

export interface Mail { to: string[]; subject: string; text: string; html?: string }
export interface SmtpResult { accepted: true; attempts: number; response: string; transcript?: string[] }
export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened: Promise<unknown>;
  close(): Promise<void> | void;
}
export type Connector = (addr: { hostname: string; port: number }, opts: { secureTransport: 'on'; allowHalfOpen: boolean }) => SmtpSocket;
export interface SendOptions { connect?: Connector; debug?: 0 | 2; commandTimeoutMs?: number; totalTimeoutMs?: number; maxAttempts?: number; backoffMs?: number }

export class SmtpError extends Error {
  constructor(public step: string, public code: number | null, message: string, public retryable: boolean, public ambiguous = false) {
    super(message);
  }
}

export const SMTP_HOST = 'smtp.gmail.com';
export const SMTP_PORT = 465;

interface SmtpConfig { username: string; password: string; from: string; fromName: string }

/** Settings for the sender, or the names of what is missing (never the values). */
export function smtpConfig(env: Env): { ok: true; cfg: SmtpConfig } | { ok: false; missing: string[] } {
  const username = (env.SMTP_USERNAME || '').trim();
  const from = (env.SMTP_FROM || '').trim();
  const password = env.SMTP_PASSWORD || '';
  const missing = [!username && 'SMTP_USERNAME', !from && 'SMTP_FROM', !password && 'SMTP_PASSWORD'].filter(Boolean) as string[];
  if (missing.length) return { ok: false, missing };
  if (!isAddress(from) || !isAddress(username)) return { ok: false, missing: ['valid SMTP_FROM / SMTP_USERNAME'] };
  return { ok: true, cfg: { username, password, from, fromName: (env.SMTP_FROM_NAME || 'Second Medic').trim() } };
}

export const smtpReady = (env: Env) => smtpConfig(env).ok;

const ADDR = /^[^\s<>()",;:\\@]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
export const isAddress = (a: string) => a.length <= 254 && ADDR.test(a);

/** A message that is safe to show or store (no secrets, no addresses, no server text that could echo them). */
export const safeSmtpError = (e: unknown) =>
  e instanceof SmtpError ? e.message : 'E-mail could not be sent (internal error)';

const enc = new TextEncoder();
const b64 = (s: string) => {
  const bytes = enc.encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const wrap76 = (s: string) => s.replace(/.{1,76}/g, (m) => m + '\r\n');
const header = (s: string) => {
  if (/[\r\n]/.test(s)) throw new SmtpError('message', null, 'E-mail subject or name contains a line break', false);
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
};

/** RFC 5322 message, multipart/alternative when there is HTML; bodies base64 (UTF-8, ₹ and Indian scripts safe). */
export function buildMessage(cfg: SmtpConfig, mail: Mail, now = new Date()): string {
  const id = crypto.randomUUID();
  const domain = cfg.from.split('@')[1];
  const name = cfg.fromName.replace(/"/g, '');
  const head = [
    `From: ${/^[\x20-\x7e]*$/.test(name) ? `"${name}"` : header(name)} <${cfg.from}>`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${header(mail.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  const part = (type: string, body: string) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(body))}`;
  if (!mail.html) return `${head.join('\r\n')}\r\n${part('text/plain', mail.text)}`;
  const boundary = `=_cd_${id.replace(/-/g, '')}`;
  return `${head.join('\r\n')}\r\nContent-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n`
    + `--${boundary}\r\n${part('text/plain', mail.text)}--${boundary}\r\n${part('text/html', mail.html)}--${boundary}--\r\n`;
}

/** Send one message. Throws SmtpError (safe message) unless Gmail accepted it. */
export async function sendMail(env: Env, mail: Mail, o: SendOptions = {}): Promise<SmtpResult> {
  const c = smtpConfig(env);
  if (!c.ok) throw new SmtpError('config', null, `E-mail is not configured (missing ${c.missing.join(', ')})`, false);
  const to = [...new Set(mail.to.map((a) => a.trim()).filter(Boolean))];
  if (!to.length) throw new SmtpError('message', null, 'No recipient', false);
  if (to.length > 50) throw new SmtpError('message', null, 'Too many recipients (50 at most)', false);
  if (!to.every(isAddress)) throw new SmtpError('message', null, 'A recipient address is not valid', false);
  const data = buildMessage(c.cfg, { ...mail, to });
  const connect = o.connect ?? ((await import('cloudflare:sockets')).connect as unknown as Connector);
  const max = Math.min(Math.max(o.maxAttempts ?? 3, 1), 5);
  const transcript: string[] | undefined = o.debug === 2 ? [] : undefined;
  let last: SmtpError | null = null;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      const response = await session(connect, c.cfg, to, data, o, transcript);
      return { accepted: true, attempts: attempt, response, transcript };
    } catch (e) {
      last = e instanceof SmtpError ? e : new SmtpError('connect', null, 'E-mail server could not be reached', true);
      transcript?.push(`-- attempt ${attempt} failed: ${last.message}`);
      if (!last.retryable || last.ambiguous || attempt === max) break;
      await new Promise((r) => setTimeout(r, (o.backoffMs ?? 1000) * attempt));
    }
  }
  throw last!;
}

async function session(connect: Connector, cfg: SmtpConfig, to: string[], data: string, o: SendOptions, transcript?: string[]): Promise<string> {
  const cmdMs = o.commandTimeoutMs ?? 15000;
  const deadline = Date.now() + (o.totalTimeoutMs ?? 45000);
  let socket: SmtpSocket;
  try {
    socket = connect({ hostname: SMTP_HOST, port: SMTP_PORT }, { secureTransport: 'on', allowHalfOpen: false });
  } catch {
    throw new SmtpError('connect', null, 'E-mail server could not be reached', true);
  }
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const dec = new TextDecoder();
  let buf = '';
  let step = 'connect';
  let dataSent = false;

  const timed = <T>(p: Promise<T>): Promise<T> => {
    const ms = Math.max(1, Math.min(cmdMs, deadline - Date.now()));
    let t: ReturnType<typeof setTimeout>;
    return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new SmtpError(step, null, `E-mail server timed out (${step})`, !dataSent, dataSent)), ms); })])
      .finally(() => clearTimeout(t));
  };
  const reply = async (): Promise<{ code: number; text: string }> => {
    const lines: string[] = [];
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        lines.push(line);
        if (/^\d{3}(?: |$)/.test(line)) {
          transcript?.push(`S: ${step === 'auth' ? line.slice(0, 3) + ' [redacted]' : line}`);
          return { code: Number(line.slice(0, 3)), text: lines.join('\n') };
        }
        if (!/^\d{3}-/.test(line)) throw new SmtpError(step, null, `Unexpected answer from the e-mail server (${step})`, !dataSent, dataSent);
        continue;
      }
      if (buf.length > 64 * 1024) throw new SmtpError(step, null, 'E-mail server answer too long', false, dataSent);
      const r = await timed(reader.read()).catch((e) => {
        throw e instanceof SmtpError ? e : new SmtpError(step, null, `E-mail connection failed (${step})`, !dataSent, dataSent);
      });
      if (r.done) throw new SmtpError(step, null, `E-mail server closed the connection (${step})`, !dataSent, dataSent);
      buf += dec.decode(r.value, { stream: true });
    }
  };
  const send = async (line: string, shown = line) => {
    transcript?.push(`C: ${shown}`);
    await timed(writer.write(enc.encode(line + '\r\n'))).catch((e) => {
      throw e instanceof SmtpError ? e : new SmtpError(step, null, `E-mail connection failed (${step})`, !dataSent, dataSent);
    });
  };
  const expect = async (s: string, ok: number[]) => {
    step = s;
    const r = await reply();
    if (!ok.includes(r.code)) {
      const enh = r.text.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1];
      const why = s === 'auth' && r.code === 535 ? 'Gmail refused the login (check the app password)' : `E-mail server refused ${s}`;
      throw new SmtpError(s, r.code, `${why}: ${r.code}${enh ? ' ' + enh : ''}`, r.code >= 400 && r.code < 500);
    }
    return r;
  };

  try {
    await timed(Promise.resolve(socket.opened)).catch((e) => {
      throw e instanceof SmtpError ? e : new SmtpError('connect', null, 'E-mail server could not be reached (TLS connection failed)', true);
    });
    await expect('greeting', [220]);
    step = 'ehlo'; await send('EHLO hhcs-caredesk.workers.dev');
    await expect('ehlo', [250]);
    step = 'auth'; await send(`AUTH PLAIN ${b64(`\0${cfg.username}\0${cfg.password}`)}`, 'AUTH PLAIN [redacted]');
    await expect('auth', [235]);
    step = 'mail'; await send(`MAIL FROM:<${cfg.from}>`, 'MAIL FROM:<[sender]>');
    await expect('mail', [250]);
    for (const r of to) { step = 'rcpt'; await send(`RCPT TO:<${r}>`, 'RCPT TO:<[redacted]>'); await expect('rcpt', [250, 251]); }
    step = 'data'; await send('DATA');
    await expect('data', [354]);
    const body = data.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    transcript?.push(`C: [message redacted, ${body.length} bytes]`);
    transcript?.push('C: .');
    dataSent = true;
    step = 'message';
    await timed(writer.write(enc.encode(body + (body.endsWith('\r\n') ? '' : '\r\n') + '.\r\n'))).catch((e) => {
      throw e instanceof SmtpError ? e : new SmtpError('message', null, 'E-mail connection failed while sending (outcome unknown)', false, true);
    });
    const done = await expect('message', [250]);
    step = 'quit';
    await send('QUIT').then(() => reply()).catch(() => {});
    return done.text.split('\n').pop()!.slice(0, 120);
  } catch (e) {
    if (e instanceof SmtpError && e.ambiguous && !/unknown/.test(e.message)) e.message += ' (outcome unknown, not retried)';
    throw e;
  } finally {
    try { reader.releaseLock(); } catch {}
    try { writer.releaseLock(); } catch {}
    try { await socket.close(); } catch {}
  }
}
