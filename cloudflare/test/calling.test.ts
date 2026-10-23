import { afterEach, expect, test, vi } from 'vitest';
import { clickToCall } from '../src/services/myoperator';
import type { Env } from '../src/env';

// Calling transport is tested in Node; the real Durable Object runs in the API rehearsal.
vi.mock('../src/services/live', () => ({ notifyLive: vi.fn() }));

const env = {
  MYOPERATOR_COMPANY_ID: 'company', MYOPERATOR_SECRET_TOKEN: 'secret',
  MYOPERATOR_OBD_API_KEY: 'key', MYOPERATOR_PUBLIC_IVR_ID: 'ivr',
} as Env;
const target = { myoperatorUserId: 'agent-1', number: '+919876543210', referenceId: 'crm-test' };
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('CRM sends one authenticated peer-to-peer user dial with a correlation reference', async () => {
  const send = vi.fn().mockResolvedValue(Response.json({ status: 'success', code: 200, unique_id: 'call-1' }));
  vi.stubGlobal('fetch', send);
  await clickToCall(env, target);
  expect(send).toHaveBeenCalledTimes(1);
  const [url, request] = send.mock.calls[0];
  expect(url).toBe('https://obd-api.myoperator.co/obd-api-v1');
  expect(request.method).toBe('POST');
  expect(request.headers).toMatchObject({ 'x-api-key': 'key', 'secret-key': 'secret' });
  expect(JSON.parse(request.body)).toMatchObject({ type: '1', user_id: 'agent-1', number: target.number,
    reference_id: target.referenceId, public_ivr_id: 'ivr', company_id: 'company', secret_token: 'secret' });
  expect(request.signal).toBeInstanceOf(AbortSignal);
});

test.each(['MYOPERATOR_COMPANY_ID', 'MYOPERATOR_SECRET_TOKEN', 'MYOPERATOR_OBD_API_KEY', 'MYOPERATOR_PUBLIC_IVR_ID'])(
  'missing %s blocks dialing without a provider request', async (key) => {
    const send = vi.fn(); vi.stubGlobal('fetch', send);
    await expect(clickToCall({ ...env, [key]: '' }, target)).rejects.toMatchObject({ status: 503 });
    expect(send).not.toHaveBeenCalled();
  });

test('an unlinked agent cannot dial', async () => {
  const send = vi.fn(); vi.stubGlobal('fetch', send);
  await expect(clickToCall(env, { ...target, myoperatorUserId: null })).rejects.toMatchObject({ status: 409 });
  expect(send).not.toHaveBeenCalled();
});

test.each([
  [400, { status: 'error', message: 'secret +919876543210' }],
  [200, { status: 'error', code: 401, message: 'secret +919876543210' }],
  [200, { status: 'success', code: 400 }],
])('provider rejection (%s) is an error with no sensitive provider text', async (status, body) => {
  const send = vi.fn().mockResolvedValue(Response.json(body, { status })); vi.stubGlobal('fetch', send);
  const error = await clickToCall(env, target).catch(e => e);
  expect(error.status).toBe(502);
  expect(error.message).not.toContain(target.number);
  expect(error.message).not.toContain('secret');
  expect(send).toHaveBeenCalledTimes(1);
});

test.each([
  [500, '{"status":"error"}'], [200, '<html>Unexpected response</html>'], [200, '{}'], [200, 'null'],
])('uncertain provider response (%s) asks the agent to check before retrying', async (status, body) => {
  const send = vi.fn().mockResolvedValue(new Response(body, { status })); vi.stubGlobal('fetch', send);
  await expect(clickToCall(env, target)).rejects.toMatchObject({ status: 504, message: expect.stringContaining('before trying again') });
  expect(send).toHaveBeenCalledTimes(1);
});

test.each(['TimeoutError', 'TypeError'])('a %s never triggers an automatic second call', async name => {
  const send = vi.fn().mockRejectedValue(Object.assign(new Error('connection lost'), { name }));
  vi.stubGlobal('fetch', send);
  await expect(clickToCall(env, target)).rejects.toMatchObject({ status: 504 });
  expect(send).toHaveBeenCalledTimes(1);
});

test('clickToCall includes referenceId in provider payload for webhook correlation', async () => {
  const send = vi.fn().mockResolvedValue(Response.json({ status: 'success', code: 200 }));
  vi.stubGlobal('fetch', send);
  await clickToCall(env, { ...target, referenceId: 'crm-ref-12345' });
  const reqBody = JSON.parse(send.mock.calls[0][1].body);
  expect(reqBody.reference_id).toBe('crm-ref-12345');
});
