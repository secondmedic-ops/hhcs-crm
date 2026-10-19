// CareDesk CRM on Cloudflare (Workers FREE plan) - the whole app in one Worker:
//   /api/*                 the backend (TypeScript: src/api, src/services, src/domain) on Supabase Postgres via Hyperdrive
//   /webhooks/myoperator   MyOperator Webhook v2 (calls + WhatsApp), checked with the shared x-webhook-key
//   scheduled()            SLA scan every minute, MIS packs at 10:00 IST
//   email()                inbound mailbox -> ticket on the patient timeline (Cloudflare Email Routing)
//   everything else        the React build (../dist) as static assets
// Deployed ONLY by the pipeline (.github/workflows/ship.yml, step 5). Workers Builds must stay disconnected.
import { accessOf, allows, authOff, User, verifyJwt, verifyToken } from './api/auth';
import type { Ctx } from './api/context';
import { errorResponse, json, noContent, readJson, toResponse } from './api/http';
import { contract, match } from './api/routes';
import { connect, schemaProblems, Sql } from './db';
import type { Env } from './env';
import { ApiError } from './domain/errors';
import { dbMessage } from './services/data';
import { handleMyOperatorWebhook } from './services/myoperator';
import { liveToken, notifyLive, openLive } from './services/live';
import { runScheduled } from './services/cron';
import { handleEmail } from './services/email';
import { resolveStaffSession, logStaffRequest } from './services/staff-session';
import { checkPublicRateLimit, httpsRedirect, isScannerProbe, secure } from './security';

export { LiveHub } from './services/live';
export type { Env };

const UNAUTHORIZED = 'Please log in again (missing or expired session).';
const FORBIDDEN = 'Your role does not allow this action. Ask a supervisor.';
const unauthorized = () => json({ status: 401, error: 'Unauthorized', message: UNAUTHORIZED }, 401);

let dbStatusCache: { up: boolean; at: number } | null = null;
async function databaseUp(env: Env, ctx: ExecutionContext): Promise<boolean> {
  const now = Date.now();
  if (dbStatusCache && now - dbStatusCache.at < 5000) return dbStatusCache.up;
  let sql: Sql | null = null;
  try {
    sql = connect(env);
    await Promise.race([sql`select 1`, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 5000))]);
    dbStatusCache = { up: true, at: now };
    return true;
  } catch (e) {
    console.error('Health: database check failed', (e as Error).message);
    dbStatusCache = { up: false, at: now };
    return false;
  } finally {
    if (sql) ctx.waitUntil(sql.end({ timeout: 2 }).catch(() => {}));
  }
}

/** Local test (RUN-LOCAL-TEST.bat, auth off): the login picked on the start screen, sent as X-Local-User. */
function localUserId(req: Request, url: URL): string | null {
  const v = req.headers.get('x-local-user') || url.searchParams.get('local_user') || (() => {
    const p = (req.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
    return p[0] === 'caredesk' && p[1]?.startsWith('local.') ? p[1].slice(6) : null;
  })();
  return v && /^[0-9a-fA-F-]{36}$/.test(v) ? v : null;
}

async function api(req: Request, env: Env, exec: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === 'OPTIONS') return noContent();
  const path = url.pathname;

  // Rehearsal-only helpers (EXPOSE_CONTRACT=1 is set by cloudflare/test/rehearse.mjs, never in production).
  if (env.EXPOSE_CONTRACT === '1' && req.method === 'GET') {
    if (path === '/api/_contract') return json(contract());
    if (path === '/api/_schema-check') {
      const sql = connect(env);
      try { return json({ problems: await schemaProblems(sql) }); } finally { exec.waitUntil(sql.end({ timeout: 2 })); }
    }
  }

  const found = match(req.method, path);
  if (typeof found !== 'number' && found.route.access === 'public') {
    const limited = checkPublicRateLimit(req, url);
    if (limited) return limited;
    switch (found.route.path) {
      case '/api/version':
        return new Response(env.BUILD_SHA || 'dev', { headers: { 'Content-Type': 'text/plain' } });
      case '/api/actuator/health/liveness':
        return json({ status: 'UP' });
      case '/api/actuator/health': {
        const up = await databaseUp(env, exec);
        return json({ status: up ? 'UP' : 'DOWN', components: { db: { status: up ? 'UP' : 'DOWN' } } }, up ? 200 : 503);
      }
      default: // /api/v1/health
        return json({ status: 'UP', service: 'hhcs-caredesk', database: (await databaseUp(env, exec)) ? 'UP' : 'DOWN',
          auth: authOff(env) ? 'off' : 'supabase', timestamp: new Date().toISOString() });
    }
  }

  // Everything else needs a login - also unknown paths, so the API reveals nothing without a token.
  const off = authOff(env);
  const isLive = path === '/api/v1/live';
  const pickList = off && path === '/api/v1/local/users';
  const who = off
    ? (localUserId(req, url) ? { id: localUserId(req, url)!, email: null } : pickList ? { id: '00000000-0000-0000-0000-000000000000', email: null } : null)
    : isLive ? await verifyJwt(liveToken(req), env) : await verifyToken(req, env);
  if (!who && checkPublicRateLimit(req, url)) return checkPublicRateLimit(req, url)!;
  if (!who) return unauthorized();
  if (found === 404) return errorResponse(404, `No endpoint ${req.method} ${path}`);
  if (found === 405) return errorResponse(405, `${req.method} is not allowed on ${path}`);

  const sql = connect(env);
  const c: Ctx = { sql, env, user: null as unknown as User, url, params: found.params, req, exec, changed: [] };
  try {
    if (pickList) {
      const users = await sql`select id::text, full_name, role::text, agent_code from profiles where active order by role, full_name`;
      return json(users);
    }
    if (path === '/api/v1/local/users') return errorResponse(404, 'Only available in the local test');
    const access = await accessOf(sql, who.id);
    const principal: User = { id: who.id, email: who.email, ...access, authMode: off ? 'off' : 'supabase' };
    // Read confinement fresh, before special routes or staff impersonation; cached roles cannot widen a machine login.
    const [identity] = await sql`select integration_only from profiles where id = ${who.id}::uuid`;
    if (identity?.integration_only) {
      const machinePath = found.route.path === '/api/v1/bmm/leads' || found.route.path === '/api/v1/bmm/leads/{id}/status';
      if (!machinePath && found.route.path !== '/api/v1/me') return errorResponse(403, FORBIDDEN);
      if (found.route.path === '/api/v1/me') {
        const [p] = await sql`select id, role::text, workspace_id from profiles where id = ${who.id}::uuid and active`;
        if (!p || p.role !== 'provider') return errorResponse(403, FORBIDDEN);
        return json({ userId: p.id, role: p.role, workspaceId: p.workspace_id, integrationOnly: true });
      }
      if (req.headers.has('X-Staff-Session')) return errorResponse(403, FORBIDDEN);
    }
    c.user = principal;
    const staffSession = path === '/api/v1/staff-sessions/end' ? null : await resolveStaffSession(c, principal);
    const user = c.user;
    if (staffSession) await logStaffRequest(c, found.route.path);
    if (found.route.path === '/api/v1/me') {
      if (!user.role) return errorResponse(403, 'Your login has no CareDesk profile yet. Ask the administrator to add you in Settings > Users.');
      return json({ userId: user.id, email: user.email, role: user.role, workspaceId: user.workspaceId, fullName: user.fullName, authMode: user.authMode, staffSession });
    }
    if (found.route.access !== 'login' && !allows(found.route.access as readonly string[], user.role)) {
      return errorResponse(403, FORBIDDEN);
    }
    if (isLive) return openLive(env, req);
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    const result = await found.route.handler!(c, body);
    if (result instanceof Response) return result;
    return json(result);
  } catch (e) {
    const mapped = e instanceof ApiError ? null : dbMessage(e);
    const res = toResponse(mapped ?? e);
    if (res.status >= 500 && !(e instanceof ApiError)) console.error('API error', found.route.path, e);
    return res;
  } finally {
    if (c.changed.length) notifyLive(env, exec, [...new Set(c.changed)]);
    exec.waitUntil(sql.end({ timeout: 2 }).catch(() => {}));
  }
}

async function route(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  if (isScannerProbe(url.pathname)) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
    });
  }
  if (url.pathname === '/webhooks/myoperator' && req.method === 'POST') {
    try { return await handleMyOperatorWebhook(req, env, ctx); } catch (e) { return toResponse(e); }
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    try { return await api(req, env, ctx); } catch (e) { return toResponse(e); }
  }
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    return httpsRedirect(req, url) ?? secure(await route(req, env, ctx, url), url, env);
  },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(event.cron, env, ctx));
  },
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
    await handleEmail(message, env, ctx);
  },
} satisfies ExportedHandler<Env>;
