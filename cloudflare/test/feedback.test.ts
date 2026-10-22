import { beforeEach, expect, test, vi } from 'vitest';
import { deliverFeedbackEmail, feedbackUrl, hashFeedbackToken } from '../src/services/feedback';
import { asSystem } from '../src/db';
import { SmtpError } from '../src/services/smtp';

vi.mock('../src/db', () => ({ asSystem: vi.fn() }));
vi.mock('../src/services/live', () => ({ notifyLive: vi.fn() }));
const claim = { id: '11111111-1111-4111-8111-111111111111', email: 'feedback@example.test', token: 'a'.repeat(64) };
const env: any = { APP_URL: 'https://feedback.example.test' };
let updates: unknown[][];
beforeEach(() => {
  updates = [];
  vi.mocked(asSystem).mockImplementation(async (_sql, fn) => {
    const tx: any = async (_strings: TemplateStringsArray, ...values: unknown[]) => { updates.push(values); return []; };
    await fn(tx);
    return { result: [], changed: ['feedback_requests'] } as any;
  });
});
test('feedback capability hashing and URL keep the token out of paths and queries', async () => {
  expect(await hashFeedbackToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const u = new URL(feedbackUrl(env.APP_URL,claim.token));
  expect(u.pathname).toBe('/feedback'); expect(u.search).toBe(''); expect(u.hash.slice(1)).toBe(claim.token);
  expect(() => feedbackUrl('http://insecure.example.test',claim.token)).toThrow('Secure feedback');
});
test('feedback email records SMTP acceptance only after send succeeds', async () => {
  const send: any = vi.fn().mockResolvedValue({ accepted:true });
  const r = await deliverFeedbackEmail(env,{} as any,claim,send);
  expect(r.status).toBe('accepted'); expect(updates[0][0]).toBe('accepted');
  expect(send.mock.calls[0][1].text).toContain('recent interaction');
  expect(send.mock.calls[0][1].text).toContain(`/feedback#${claim.token}`);
  expect(send.mock.calls[0][1].text).not.toContain('Patient');
});
test('feedback email preserves rejected and unconfirmed SMTP outcomes', async () => {
  const reject: any = vi.fn().mockRejectedValue(new SmtpError('rcpt',550,'Recipient rejected',false));
  expect((await deliverFeedbackEmail(env,{} as any,claim,reject)).status).toBe('failed');
  const unknown: any = vi.fn().mockRejectedValue(new SmtpError('data',null,'Email outcome unconfirmed',false,true));
  expect((await deliverFeedbackEmail(env,{} as any,claim,unknown)).status).toBe('unknown');
  expect(updates.map(u=>u[0])).toEqual(['failed','unknown']);
  expect(reject).toHaveBeenCalledTimes(1); expect(unknown).toHaveBeenCalledTimes(1);
});
