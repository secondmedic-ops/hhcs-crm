import { afterEach, expect, test, vi } from 'vitest';
import { gemini, transcribeToken, GeminiLimitError } from '../src/services/ai';
import type { Env } from '../src/env';

vi.mock('../src/services/live', () => ({ notifyLive: vi.fn() }));
const env = { GEMINI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-3.8-flash' } as Env;
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('summary retries temporary Google overload with the same model and succeeds', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'High demand', status: 'UNAVAILABLE' } }, { status: 503 }))
    .mockResolvedValue(Response.json({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }));
  vi.stubGlobal('fetch', send);
  const result = gemini(env, [{ text: 'Reply with ok' }]);
  await vi.runAllTimersAsync();
  await expect(result).resolves.toEqual({ ok: true });
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.every(([url]) => url.includes('/gemini-3.8-flash:generateContent'))).toBe(true);
});

test('continued Google overload stops after three attempts and retains the pause error', async () => {
  vi.useFakeTimers();
  const send = vi.fn(() => Promise.resolve(Response.json({ error: { message: 'High demand' } }, { status: 503 })));
  vi.stubGlobal('fetch', send);
  const result = gemini(env, [{ text: 'Test' }]);
  const assertion = expect(result).rejects.toBeInstanceOf(GeminiLimitError);
  await vi.runAllTimersAsync(); await assertion;
  expect(send).toHaveBeenCalledTimes(3);
});

test('quota and invalid keys are not rapidly retried', async () => {
  for (const status of [429, 403]) {
    const send = vi.fn(() => Promise.resolve(Response.json({ error: { message: 'Request refused' } }, { status })));
    vi.stubGlobal('fetch', send);
    await expect(gemini(env, [{ text: 'Test' }])).rejects.toBeInstanceOf(GeminiLimitError);
    expect(send).toHaveBeenCalledTimes(1);
  }
});

test('token creation also recovers from temporary Google capacity errors', async () => {
  vi.useFakeTimers();
  const send = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: 'Busy' } }, { status: 503 }))
    .mockResolvedValue(Response.json({ name: 'auth_tokens/test' }));
  vi.stubGlobal('fetch', send);
  const result = transcribeToken(env);
  await vi.runAllTimersAsync();
  await expect(result).resolves.toMatchObject({ token: 'auth_tokens/test' });
  expect(send).toHaveBeenCalledTimes(2);
});
