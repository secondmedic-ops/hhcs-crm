import { test, expect } from 'vitest';
import { contentSecurityPolicy, httpsRedirect, secure } from '../src/security';

const env = { SUPABASE_URL: 'https://eilshdpbnhcohroujaui.supabase.co' };

test('plain HTTP on the live host redirects to HTTPS; local runs and webhooks do not', () => {
  const live = (path: string, method = 'GET') => {
    const url = new URL('http://hhcs-caredesk.secondmedic.workers.dev' + path);
    return httpsRedirect(new Request(url, { method }), url);
  };
  const page = live('/cases?x=1');
  expect(page?.status).toBe(301);
  expect(page?.headers.get('Location')).toBe('https://hhcs-caredesk.secondmedic.workers.dev/cases?x=1');
  expect(live('/api/v1/batch', 'POST')?.status).toBe(308);
  expect(live('/webhooks/myoperator', 'POST')).toBeNull();
  for (const u of ['http://127.0.0.1:8787/api/v1/me', 'http://localhost:3000/', 'https://hhcs-caredesk.secondmedic.workers.dev/']) {
    const url = new URL(u);
    expect(httpsRedirect(new Request(url), url)).toBeNull();
  }
});

test('security headers on HTTPS responses; WebSocket upgrades untouched', async () => {
  const url = new URL('https://hhcs-caredesk.secondmedic.workers.dev/cases');
  const res = secure(new Response('ok', { headers: { 'Content-Type': 'text/html' } }), url, env);
  expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Content-Type')).toBe('text/html');
  expect(await res.text()).toBe('ok');
  const csp = res.headers.get('Content-Security-Policy')!;
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain('wss://hhcs-caredesk.secondmedic.workers.dev');
  expect(csp).toContain('https://eilshdpbnhcohroujaui.supabase.co');
  expect(csp).toContain('wss://generativelanguage.googleapis.com');
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(csp).not.toMatch(/script-src[^;]*data:/);
  const local = contentSecurityPolicy(new URL('http://127.0.0.1:8787/'), {});
  expect(local).toContain('ws://127.0.0.1:8787');
  expect(local).not.toContain('upgrade-insecure-requests');
  const ws = new Response(null, { status: 200 });
  Object.defineProperty(ws, 'webSocket', { value: {} });
  expect(secure(ws, url, env)).toBe(ws);
});
