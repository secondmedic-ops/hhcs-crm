// Browser security for every response the Worker returns: HTTP -> HTTPS, HSTS, Content-Security-Policy and the
// usual hardening headers. Pages go through the Worker (wrangler.jsonc run_worker_first); hashed files under
// /assets/* are served directly and get their headers from public/_headers.
import type { Env } from './env';

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;
const TRACKER = 'https://system-tracker.secondmedic.workers.dev';
const GEMINI = 'generativelanguage.googleapis.com';

/** Plain-HTTP request on the live host -> permanent redirect to HTTPS (method kept). MyOperator webhooks are left
 *  alone so a webhook saved with http:// keeps working; local runs (wrangler dev on 127.0.0.1) are never redirected. */
export function httpsRedirect(req: Request, url: URL): Response | null {
  if (url.protocol !== 'http:' || LOCAL.test(url.hostname) || url.pathname.startsWith('/webhooks/')) return null;
  const to = new URL(url);
  to.protocol = 'https:';
  return new Response(null, { status: req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, headers: { Location: to.toString() } });
}

export function contentSecurityPolicy(url: URL, env: Pick<Env, 'SUPABASE_URL'>): string {
  const secure = url.protocol === 'https:';
  let supabase = '';
  try { supabase = env.SUPABASE_URL ? new URL(env.SUPABASE_URL).origin : ''; } catch { /* unset in local runs */ }
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${TRACKER}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${secure ? 'wss' : 'ws'}://${url.host} ${supabase} wss://${GEMINI} https://${GEMINI} ${TRACKER}`.replace(/ +/g, ' '),
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(secure ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/** Adds the security headers. WebSocket upgrades (101) pass through untouched. */
export function secure(res: Response, url: URL, env: Pick<Env, 'SUPABASE_URL'>): Response {
  if (res.status === 101 || (res as Response & { webSocket?: unknown }).webSocket) return res;
  const out = new Response(res.body, res);
  const h = out.headers;
  if (url.protocol === 'https:') h.set('Strict-Transport-Security', 'max-age=31536000');
  h.set('Content-Security-Policy', contentSecurityPolicy(url, env));
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'microphone=(self), geolocation=(self), camera=(), payment=(), usb=()');
  return out;
}
