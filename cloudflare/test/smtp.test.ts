// Gmail SMTP sender (services/smtp.ts) and the MIS send-once rule (services/cron.ts) against a MOCK SMTP server.
// No network: these prove the protocol, timeouts, retries and redaction, not that Gmail accepts the real password.
import { describe, expect, it, vi } from 'vitest';
import { buildMessage, sendMail, SmtpError, type Connector } from '../src/services/smtp';

vi.mock('../src/services/ai', () => ({ misNarrative: vi.fn(), summariseBacklog: vi.fn() }));
vi.mock('../src/services/ai-config', () => ({ aiEnv: vi.fn() }));
vi.mock('../src/services/mo-sync', () => ({ syncCallLogs: vi.fn() }));
vi.mock('../src/services/autodial', () => ({ runAutodial: vi.fn() }));
vi.mock('../src/services/live', () => ({ notifyLive: vi.fn() }));
vi.mock('../src/db', () => ({ asSystem: vi.fn(), connect: vi.fn() }));

const PASSWORD = 'abcd efgh ijkl mnop';
const env: any = { SMTP_USERNAME: 'customer.support@secondmedic.com', SMTP_FROM: 'customer.support@secondmedic.com', SMTP_FROM_NAME: 'Second Medic', SMTP_PASSWORD: PASSWORD };
const fast = { backoffMs: 1, commandTimeoutMs: 50, totalTimeoutMs: 2000 };

type Script = Partial<Record<'greeting' | 'ehlo' | 'auth' | 'mail' | 'rcpt' | 'data' | 'message', string | null>>;

/** A fake smtp.gmail.com. null = never answers (timeout); 'CLOSE' = drops the connection. */
function mockServer(scripts: Script[], opts: { failConnect?: number } = {}) {
  const log: { opts: any; addr: any; client: string[] }[] = [];
  let n = 0;
  const connect: Connector = (addr, o) => {
    const script = scripts[Math.min(n, scripts.length - 1)];
    n++;
    const entry = { opts: o, addr, client: [] as string[] };
    log.push(entry);
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const say = (step: keyof Script, def: string) => {
      const v = step in script ? script[step] : def;
      if (v === null) return;
      if (v === 'CLOSE') { try { ctrl.close(); } catch {} return; }
      ctrl.enqueue(new TextEncoder().encode(v + '\r\n'));
    };
    let inData = false, buf = '';
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        buf += new TextDecoder().decode(chunk);
        if (inData) {
          if (buf.endsWith('\r\n.\r\n')) { entry.client.push(buf); buf = ''; inData = false; say('message', '250 2.0.0 OK  1697 - gsmtp'); }
          return;
        }
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          entry.client.push(line);
          if (line.startsWith('EHLO')) say('ehlo', '250-smtp.gmail.com at your service\r\n250-AUTH LOGIN PLAIN\r\n250 SMTPUTF8');
          else if (line.startsWith('AUTH')) say('auth', '235 2.7.0 Accepted');
          else if (line.startsWith('MAIL')) say('mail', '250 2.1.0 OK');
          else if (line.startsWith('RCPT')) say('rcpt', '250 2.1.5 OK');
          else if (line === 'DATA') { inData = true; say('data', '354 Go ahead'); }
          else if (line === 'QUIT') say('data', '221 2.0.0 closing');
        }
      },
    });
    const opened = opts.failConnect && n <= opts.failConnect ? Promise.reject(new Error('connect ECONNREFUSED')) : Promise.resolve({});
    opened.catch(() => {});
    queueMicrotask(() => { if (!(opts.failConnect && n <= opts.failConnect)) say('greeting', '220 smtp.gmail.com ESMTP ready'); });
    return { readable, writable, opened, close: () => {} };
  };
  return { connect, log, count: () => n };
}

const mail = { to: ['customer.support@secondmedic.com'], subject: 'Test ₹', text: 'Hello\n.dot line', html: '<p>Hello</p>' };

describe('Gmail SMTP sender', () => {
  it('sends over implicit TLS to smtp.gmail.com:465 with AUTH PLAIN, and redacts the debug log', async () => {
    const s = mockServer([{}]);
    const r = await sendMail(env, mail, { ...fast, connect: s.connect, debug: 2 });
    expect(r.accepted).toBe(true);
    expect(r.attempts).toBe(1);
    expect(s.log[0].addr).toEqual({ hostname: 'smtp.gmail.com', port: 465 });
    expect(s.log[0].opts.secureTransport).toBe('on');
    const auth = s.log[0].client.find((l) => l.startsWith('AUTH PLAIN '))!;
    expect(atob(auth.slice(11))).toBe(`\0${env.SMTP_USERNAME}\0${PASSWORD}`);
    const body = s.log[0].client.find((l) => l.includes('MIME-Version'))!;
    expect(body).toContain('From: "Second Medic" <customer.support@secondmedic.com>');
    expect(body).toContain('multipart/alternative');
    expect(body).toContain('Subject: =?UTF-8?B?');
    const t = r.transcript!.join('\n');
    expect(t).toContain('AUTH PLAIN [redacted]');
    expect(t).toContain('RCPT TO:<[redacted]>');
    expect(t).toContain('[message redacted');
    expect(t).not.toContain(btoa(`\0${env.SMTP_USERNAME}\0${PASSWORD}`));
    expect(t).not.toContain('Hello');
    expect(t).not.toMatch(/RCPT TO:<customer/);
  });

  it('wrong app password: safe error, no retry, password never in the message', async () => {
    const s = mockServer([{ auth: '535-5.7.8 Username and Password not accepted.\r\n535 5.7.8 https://support.google.com/mail/?p=BadCredentials' }]);
    const e = await sendMail(env, mail, { ...fast, connect: s.connect }).catch((x) => x);
    expect(e).toBeInstanceOf(SmtpError);
    expect(e.step).toBe('auth');
    expect(e.code).toBe(535);
    expect(e.message).toMatch(/app password/);
    expect(e.message).not.toContain(PASSWORD);
    expect(s.count()).toBe(1);
  });

  it('connection refused: retried, at most 3 attempts', async () => {
    const s = mockServer([{}], { failConnect: 99 });
    const e = await sendMail(env, mail, { ...fast, connect: s.connect }).catch((x) => x);
    expect(e).toBeInstanceOf(SmtpError);
    expect(e.retryable).toBe(true);
    expect(s.count()).toBe(3);
  });

  it('greeting timeout then success on the retry', async () => {
    const s = mockServer([{ greeting: null }, {}]);
    const r = await sendMail(env, mail, { ...fast, connect: s.connect });
    expect(r.attempts).toBe(2);
  });

  it('temporary 4xx on RCPT is retried; 5xx is not', async () => {
    const t = mockServer([{ rcpt: '451 4.3.0 try again' }, {}]);
    expect((await sendMail(env, mail, { ...fast, connect: t.connect })).attempts).toBe(2);
    const p = mockServer([{ rcpt: '550 5.1.1 no such user' }]);
    const e = await sendMail(env, mail, { ...fast, connect: p.connect }).catch((x) => x);
    expect(e.code).toBe(550);
    expect(p.count()).toBe(1);
  });

  it('answer lost after the message was handed over: outcome unknown, never retried (no duplicate)', async () => {
    for (const message of [null, 'CLOSE']) {
      const s = mockServer([{ message }]);
      const e = await sendMail(env, mail, { ...fast, connect: s.connect }).catch((x) => x);
      expect(e).toBeInstanceOf(SmtpError);
      expect(e.ambiguous).toBe(true);
      expect(e.message).toMatch(/unknown/);
      expect(s.count()).toBe(1);
    }
  });

  it('not configured, bad recipients and header injection fail before connecting', async () => {
    const s = mockServer([{}]);
    await expect(sendMail({ ...env, SMTP_PASSWORD: '' }, mail, { connect: s.connect })).rejects.toThrow(/missing SMTP_PASSWORD/);
    await expect(sendMail(env, { ...mail, to: ['a@b.com>\r\nRCPT TO:<x@y.z'] }, { connect: s.connect })).rejects.toThrow(/not valid/);
    await expect(sendMail(env, { ...mail, subject: 'Hi\r\nBcc: x@y.z' }, { connect: s.connect })).rejects.toThrow(/line break/);
    expect(s.count()).toBe(0);
  });

  it('encodes bodies as base64, so no raw body line can end the DATA section', () => {
    const m = buildMessage({ username: 'a@b.co', password: 'x', from: 'a@b.co', fromName: 'A' }, { to: ['c@d.co'], subject: 's', text: 'x' });
    expect(m).toContain('Content-Transfer-Encoding: base64');
  });
});

describe('MIS e-mail: one send per snapshot', () => {
  const fakeSql = (claim: unknown[]) => {
    const calls: { q: string; v: unknown[] }[] = [];
    const sql: any = (strings: TemplateStringsArray, ...v: unknown[]) => {
      const q = strings.join('?');
      calls.push({ q, v });
      const p: any = Promise.resolve(/set email_status = 'sending'/.test(q) ? claim : []);
      return p;
    };
    sql.json = (x: unknown) => x;
    return { sql, calls };
  };
  const data = { calls: { total: 3 }, funnel: {}, revenue: {}, collections: {} };
  const misEnv = { ...env, MIS_RECIPIENTS: 'a@hinduja.test, b@hinduja.test' };

  it('already sent or claimed: nothing is sent', async () => {
    const { emailMis } = await import('../src/services/cron');
    const { sql } = fakeSql([]);
    const send = vi.fn();
    expect(await emailMis(misEnv, sql, 'id1', 'ws', 'daily', '2026-10-16', '2026-10-16', data, null, send as any)).toEqual({ skipped: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('failed send is recorded as failed, never accepted', async () => {
    const { emailMis } = await import('../src/services/cron');
    const { sql, calls } = fakeSql([{ id: 'id1' }]);
    const send = vi.fn().mockRejectedValue(new SmtpError('auth', 535, 'Gmail refused the login (check the app password): 535 5.7.8', false));
    const r = await emailMis(misEnv, sql, 'id1', 'ws', 'daily', '2026-10-16', '2026-10-16', data, null, send as any);
    expect(r).toEqual({ status: 'failed', error: 'Gmail refused the login (check the app password): 535 5.7.8' });
    const upd = calls.find((c) => /set email_status = \?, email_error/.test(c.q))!;
    expect(upd.v[0]).toBe('failed');
    expect(send.mock.calls[0][1].to).toEqual(['a@hinduja.test', 'b@hinduja.test']);
  });

  it('lost answer after DATA is recorded as unknown (not re-sent by the claim rule)', async () => {
    const { emailMis } = await import('../src/services/cron');
    const { sql, calls } = fakeSql([{ id: 'id1' }]);
    const send = vi.fn().mockRejectedValue(new SmtpError('message', null, 'lost', false, true));
    expect((await emailMis(misEnv, sql, 'id1', 'ws', 'daily', '2026-10-16', '2026-10-16', data, null, send as any)).status).toBe('unknown');
    expect(calls[0].q).toMatch(/not in \('accepted', 'unknown'\)/);
  });

  it('accepted send sets emailed_at through the accepted status', async () => {
    const { emailMis } = await import('../src/services/cron');
    const { sql, calls } = fakeSql([{ id: 'id1' }]);
    const send = vi.fn().mockResolvedValue({ accepted: true, attempts: 1, response: '250 OK' });
    expect((await emailMis(misEnv, sql, 'id1', 'ws', 'daily', '2026-10-16', '2026-10-16', data, 'Calm day.', send as any)).status).toBe('accepted');
    expect(calls.find((c) => /emailed_at = case when/.test(c.q))!.v[0]).toBe('accepted');
    const m = send.mock.calls[0][1];
    expect(m.html).toContain('Calm day.');
    expect(m.text).toContain('Calls: 3');
  });
});
