import { test, expect } from 'vitest';
import { contentSecurityPolicy, httpsRedirect, secure } from '../src/security';

const env = { SUPABASE_URL: 'https://eilshdpbnhcohroujaui.supabase.co' };

test('plain HTTP on the live host redirects to HTTPS; local runs and webhooks do not', () => {
  const live = (path: string, method = 'GET') => {
    const url = new URL('http://hhcs-caredesk.smdevs.workers.dev' + path);
    return httpsRedirect(new Request(url, { method }), url);
  };
  const page = live('/cases?x=1');
  expect(page?.status).toBe(301);
  expect(page?.headers.get('Location')).toBe('https://hhcs-caredesk.smdevs.workers.dev/cases?x=1');
  expect(live('/api/v1/batch', 'POST')?.status).toBe(308);
  expect(live('/webhooks/myoperator', 'POST')).toBeNull();
  for (const u of ['http://127.0.0.1:8787/api/v1/me', 'http://localhost:3000/', 'https://hhcs-caredesk.smdevs.workers.dev/']) {
    const url = new URL(u);
    expect(httpsRedirect(new Request(url), url)).toBeNull();
  }
});

test('security headers on HTTPS responses; WebSocket upgrades untouched', async () => {
  const url = new URL('https://hhcs-caredesk.smdevs.workers.dev/cases');
  const res = secure(new Response('ok', { headers: { 'Content-Type': 'text/html' } }), url, env);
  expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
  expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Content-Type')).toBe('text/html');
  expect(await res.text()).toBe('ok');
  const csp = res.headers.get('Content-Security-Policy')!;
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain('wss://hhcs-caredesk.smdevs.workers.dev');
  expect(csp).toContain('https://eilshdpbnhcohroujaui.supabase.co');
  expect(csp).toContain('wss://generativelanguage.googleapis.com');
  expect(csp).toContain('https://*.tile.openstreetmap.org');
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(csp).not.toMatch(/script-src[^;]*data:/);
  const local = contentSecurityPolicy(new URL('http://127.0.0.1:8787/'), {});
  expect(local).toContain('ws://127.0.0.1:8787');
  expect(local).not.toContain('upgrade-insecure-requests');
  const ws = new Response(null, { status: 200 });
  Object.defineProperty(ws, 'webSocket', { value: {} });
  expect(secure(ws, url, env)).toBe(ws);
});

test('scanner probe detection blocks exploit endpoints and dotfiles but allows valid routes', async () => {
  const { isScannerProbe } = await import('../src/security');
  // Exploit probes blocked
  expect(isScannerProbe('/.env')).toBe(true);
  expect(isScannerProbe('/.git/config')).toBe(true);
  expect(isScannerProbe('/.aws/credentials')).toBe(true);
  expect(isScannerProbe('/wp-login.php')).toBe(true);
  expect(isScannerProbe('/wp-admin/')).toBe(true);
  expect(isScannerProbe('/xmlrpc.php')).toBe(true);
  expect(isScannerProbe('/phpmyadmin/index.php')).toBe(true);
  expect(isScannerProbe('/actuator/env')).toBe(true);
  expect(isScannerProbe('/api/actuator/heapdump')).toBe(true);
  expect(isScannerProbe('/server.php')).toBe(true);
  expect(isScannerProbe('/backup.sql')).toBe(true);

  // Normal routes allowed
  expect(isScannerProbe('/')).toBe(false);
  expect(isScannerProbe('/cases')).toBe(false);
  expect(isScannerProbe('/cases/123')).toBe(false);
  expect(isScannerProbe('/api/v1/health')).toBe(false);
  expect(isScannerProbe('/api/v1/batch')).toBe(false);
  expect(isScannerProbe('/api/actuator/health')).toBe(false);
  expect(isScannerProbe('/api/actuator/health/liveness')).toBe(false);
  expect(isScannerProbe('/assets/index.js')).toBe(false);
});

test('rate limiter blocks unauthenticated scanner flooding with 429', async () => {
  const { checkPublicRateLimit, resetRateLimitsForTesting } = await import('../src/security');
  resetRateLimitsForTesting();
  const remoteUrl = new URL('https://hhcs-caredesk.smdevs.workers.dev/api/v1/health');
  const req = new Request(remoteUrl, { headers: { 'cf-connecting-ip': '198.51.100.42' } });

  // First 120 requests allowed
  for (let i = 0; i < 120; i++) {
    expect(checkPublicRateLimit(req, remoteUrl)).toBeNull();
  }

  // 121st request rate-limited
  const limited = checkPublicRateLimit(req, remoteUrl);
  expect(limited?.status).toBe(429);
  expect(limited?.headers.get('Retry-After')).toBeDefined();
  expect(await limited?.json()).toMatchObject({ status: 429, error: 'Too Many Requests' });
  resetRateLimitsForTesting();
});
