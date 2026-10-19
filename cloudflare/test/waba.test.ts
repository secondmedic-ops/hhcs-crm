import { afterEach, expect, test, vi } from 'vitest';
import type { Env } from '../src/env';
import type { Sql } from '../src/db';
import type { Ctx } from '../src/api/context';
import { clearMoCache, describeMo, moEnv, wabaConfiguration } from '../src/services/myoperator-config';
import { sendWhatsApp, testWaba } from '../src/services/myoperator';

vi.mock('../src/services/live', () => ({ notifyLive: vi.fn() }));
afterEach(() => { clearMoCache(); vi.unstubAllGlobals(); });
const env = { MYOPERATOR_COMPANY_ID: 'company', MYOPERATOR_WABA_API_KEY: 'secret-key', MYOPERATOR_WABA_PHONE_ID: '123' } as Env;
const sql = (settings = {}) => vi.fn(async () => [{ settings }]) as unknown as Sql;
const ctx = (settings = {}) => ({ env, sql: sql(settings) }) as Ctx;
const phone = { phone_number_id: '123', status: 'active', phone_number_status: 'connected', onboarding_status: 'success' };
const response = (results: unknown[], next: string | null = null) => Response.json({ status: 'success', code: '200', data: { results, next } });

test('database WABA fields override secrets individually; blank fields fall back and both sources are trimmed', async () => {
  const db = sql({ waba_api_key: ' app-key ', waba_phone_id: '  ' });
  const resolved = await moEnv({ ...env, MYOPERATOR_WABA_PHONE_ID: ' 123 ' }, db);
  expect(resolved.MYOPERATOR_WABA_API_KEY).toBe('app-key');
  expect(resolved.MYOPERATOR_WABA_PHONE_ID).toBe('123');
  expect(wabaConfiguration(resolved).status).toBe('configured');
  const fields = await describeMo(env, db);
  expect(fields.find(f => f.key === 'waba_api_key')).toMatchObject({ source: 'app', value: '…-key' });
  expect(fields.find(f => f.key === 'waba_phone_id')).toMatchObject({ source: 'secret' });
  expect(JSON.stringify(fields)).not.toContain('app-key');
});

test('missing database configuration falls back to environment secrets', async () => {
  const db = vi.fn(async () => { throw Error('DB unavailable'); }) as unknown as Sql;
  expect(await moEnv(env, db)).toMatchObject(env);
});

test('missing company or WABA fields prevents lookup and never reports connected', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  const result = await testWaba({ ...ctx(), env: { MYOPERATOR_WABA_API_KEY: ' ' } as Env });
  expect(result).toMatchObject({ ok: false, status: 'missing_credentials' });
  expect(result.missing).toHaveLength(3);
  expect(fetcher).not.toHaveBeenCalled();
});

test('diagnostic uses saved credentials for GET only and returns no provider payload or credentials', async () => {
  const fetcher = vi.fn(async () => response([phone])); vi.stubGlobal('fetch', fetcher);
  const result = await testWaba(ctx({ waba_api_key: 'app-key' }));
  expect(result).toMatchObject({ ok: true, status: 'connected' });
  expect(JSON.stringify(result)).not.toMatch(/app-key|secret-key|phone_number_id/);
  const [url, options] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.pathname).toBe('/chat/phonenumbers');
  expect(options).toMatchObject({ method: 'GET', redirect: 'manual', headers: { Authorization: 'Bearer app-key', 'X-MYOP-COMPANY-ID': 'company' } });
  expect(options.body).toBeUndefined();
});

test.each([
  { ...phone, phone_number_id: 'other' },
  { ...phone, status: 'inactive' },
  { ...phone, onboarding_status: 'pending' },
  { ...phone, phone_number_status: 'otp_verified' },
])('unmatched or inactive phone cannot report connected: %j', async row => {
  vi.stubGlobal('fetch', vi.fn(async () => response([row])));
  expect(await testWaba(ctx())).toMatchObject({ ok: false, status: 'configured' });
});

test.each([401, 403, 429, 500])('provider HTTP %s is safely reported without reflecting secrets', async status => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-key', { status })));
  const result = await testWaba(ctx());
  expect(result).toMatchObject({ ok: false, status: 'configured' });
  expect(JSON.stringify(result)).not.toContain('secret-key');
});

test('HTTP 200 provider errors, invalid JSON and network errors do not report Connected', async () => {
  const fetcher = vi.fn()
    .mockResolvedValueOnce(Response.json({ status: 'error', code: '401', message: 'secret-key' }))
    .mockResolvedValueOnce(new Response('secret-key'))
    .mockRejectedValueOnce(Error('secret-key'));
  vi.stubGlobal('fetch', fetcher);
  for (let i = 0; i < 3; i++) {
    const result = await testWaba(ctx());
    expect(result).toMatchObject({ ok: false, status: 'configured' });
    expect(JSON.stringify(result)).not.toContain('secret-key');
  }
});

test('pagination checks the matching ID without forwarding credentials to a next URL', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response([], 'https://untrusted.test/next')).mockResolvedValueOnce(response([phone]));
  vi.stubGlobal('fetch', fetcher);
  expect((await testWaba(ctx())).ok).toBe(true);
  expect(String(fetcher.mock.calls[1][0])).toBe('https://publicapi.myoperator.co/chat/phonenumbers?limit=100&offset=100');
});

test('pagination is bounded and never treats a truncated search as verified', async () => {
  const fetcher = vi.fn(async () => response([], 'next')); vi.stubGlobal('fetch', fetcher);
  expect(await testWaba(ctx())).toMatchObject({ ok: false, status: 'configured' });
  expect(fetcher).toHaveBeenCalledTimes(5);
});

test('sendWhatsApp itself loads database overrides, preserving the send authentication contract', async () => {
  const fetcher = vi.fn(async () => Response.json({ id: 'message' })); vi.stubGlobal('fetch', fetcher);
  await sendWhatsApp(env, { to: '+919800000001', text: 'test' }, sql({ waba_api_key: 'app-key', waba_phone_id: '456' }));
  const [url, options] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('https://publicapi.myoperator.co/chat/messages');
  expect(options).toMatchObject({ method: 'POST', headers: { Authorization: 'Bearer app-key' } });
  expect(JSON.parse(options.body as string).phone_number_id).toBe('456');
});

test('missing WABA credentials cannot queue through a legacy QR session', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  expect(await sendWhatsApp({} as Env, { to: '+919800000001', text: 'test' }, sql({ status: 'connected' }))).toHaveProperty('skipped');
  expect(fetcher).not.toHaveBeenCalled();
});
