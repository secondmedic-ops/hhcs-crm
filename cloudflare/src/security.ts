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
    "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://*.openstreetmap.org https://*.tile.osm.org https://tile.osm.org https://*.tile.openstreetmap.fr https://tile.openstreetmap.fr https://unpkg.com https://cdnjs.cloudflare.com",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${secure ? 'wss' : 'ws'}://${url.host} ${supabase} wss://${GEMINI} https://${GEMINI} ${TRACKER} https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://*.openstreetmap.org https://*.tile.openstreetmap.fr https://tile.openstreetmap.fr`.replace(/ +/g, ' '),
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
  if (!h.has('Access-Control-Allow-Origin')) {
    h.set('Access-Control-Allow-Origin', '*');
  }
  return out;
}

/** Detects automated scanner probes and exploit attempts trying to discover sensitive files, CMS backdoors or config. */
export function isScannerProbe(pathname: string): boolean {
  const p = pathname.toLowerCase();
  // Hidden / dotfiles (e.g. /.env, /.git, /.svn, /.aws, /.DS_Store)
  if (p.startsWith('/.') && !p.startsWith('/.well-known/')) return true;
  // Script / server backdoors outside normal app assets
  if (/\.(php|asp|aspx|jsp|cgi|env|git|bak|old|sql|ini|yml|yaml|config|sh|bat)$/i.test(p)) return true;
  // Common automated scanner exploit endpoints
  if (/^\/(wp-admin|wp-login|xmlrpc|phpmyadmin|adminer|solr|cgi-bin|etc\/passwd)/i.test(p)) return true;
  // Unmapped actuator endpoints (only /api/actuator/health* are valid in this API)
  if (/^\/actuator(\/|$)/i.test(p) || (/^\/api\/actuator\//i.test(p) && !/^\/api\/actuator\/health(\/|$)/i.test(p))) return true;
  return false;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitBucket>();
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_UNAUTH_PER_MINUTE = 120;

/** Client IP resolver */
export function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    '127.0.0.1'
  );
}

/** Rate limiter for unauthenticated requests and public endpoints.
 * Returns null if allowed, or a 429 Response if rate limit is exceeded. */
export function checkPublicRateLimit(req: Request, url: URL): Response | null {
  const ip = clientIp(req);
  if (LOCAL.test(ip) || LOCAL.test(url.hostname)) return null;

  const now = Date.now();
  const bucket = rateLimitMap.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    if (rateLimitMap.size > 2000) {
      for (const [k, v] of rateLimitMap.entries()) {
        if (now > v.resetAt) rateLimitMap.delete(k);
      }
    }
    return null;
  }

  bucket.count++;
  if (bucket.count > MAX_UNAUTH_PER_MINUTE) {
    const retrySecs = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return new Response(
      JSON.stringify({ status: 429, error: 'Too Many Requests', message: 'Too many requests. Please slow down.' }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(retrySecs),
          'X-RateLimit-Limit': String(MAX_UNAUTH_PER_MINUTE),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(Math.ceil(bucket.resetAt / 1000)),
        },
      }
    );
  }
  return null;
}

/** Reset rate limit buckets (for testing) */
export function resetRateLimitsForTesting() {
  rateLimitMap.clear();
}

