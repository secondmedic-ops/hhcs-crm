// Every business call needs a Supabase access token (Authorization: Bearer ...), verified here with the project's
// ES256 signing keys (JWKS), issuer <SUPABASE_URL>/auth/v1 and audience "authenticated". The role comes from
// public.profiles (set by an admin in Settings > Users, never from user_metadata, which users can edit), cached 60 s.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Db } from '../db';
import { databaseUrl, isLocalDb } from '../db';
import type { Env } from '../env';

export const ROLES = ['agent', 'coordinator', 'supervisor', 'field_staff', 'medical_desk', 'client_manager', 'client_clinical', 'admin', 'provider', 'administrator'] as const;
export type Role = (typeof ROLES)[number];

/** Same rule as has_role() in the database: an administrator may do anything a senior role may (supervisor, Hinduja
 *  management or clinical, coordinator, medical desk) and anything the platform admin may (logins, configuration). Lists
 *  of only agent / field staff / partner roles stay closed to it: those are scoped to one person's own work. */
const SENIOR: readonly string[] = ['supervisor', 'client_manager', 'client_clinical', 'coordinator', 'medical_desk', 'admin'];
export const allows = (roles: readonly string[] | undefined, role: Role | null | undefined): boolean =>
  !!role && !!roles && (roles.includes(role) || (role === 'administrator' && roles.some((r) => SENIOR.includes(r))));

export interface User {
  id: string;
  email: string | null;
  role: Role | null;
  workspaceId: string | null;
  fullName: string | null;
  agentCode: string | null;
  myoperatorUserId: string | null;
  authMode: 'supabase' | 'off';
}

const jwksBySupabase = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
type Access = Omit<User, 'id' | 'email' | 'authMode'> & { at: number };
const cache = new Map<string, Access>();
const CACHE_MS = 60_000;

export const supabaseBase = (env: Env) => (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');

/** True when this Worker may run without login: AUTH_MODE=off AND the database is on this computer. */
export function authOff(env: Env): boolean {
  if ((env.AUTH_MODE || '').toLowerCase() !== 'off') return false;
  const url = databaseUrl(env);
  if (!url || !isLocalDb(url)) {
    throw new Error('AUTH_MODE=off is for the local test database only and is refused for any other database.');
  }
  return true;
}

/** The verified user id and email from a token, or null when there is no valid token. */
export async function verifyJwt(raw: string | null | undefined, env: Env): Promise<{ id: string; email: string | null } | null> {
  if (!raw) return null;
  const base = supabaseBase(env);
  if (!base) throw new Error('SUPABASE_URL is not set - no login can be verified.');
  let jwks = jwksBySupabase.get(base);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(base + '/auth/v1/.well-known/jwks.json'), { cacheMaxAge: 10 * 60_000 });
    jwksBySupabase.set(base, jwks);
  }
  try {
    const { payload } = await jwtVerify(raw.trim(), jwks, {
      algorithms: ['ES256'],
      issuer: base + '/auth/v1',
      audience: 'authenticated',
    });
    if (!payload.sub) return null;
    return { id: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
  } catch (e) {
    console.warn('Login token refused:', (e as Error)?.name, (e as Error)?.message);
    return null;
  }
}

export async function verifyToken(req: Request, env: Env) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return verifyJwt(m?.[1], env);
}

/** Role, workspace and MyOperator id of a login (public.profiles, active only), cached for 60 seconds. */
export async function accessOf(db: Db, userId: string): Promise<Access> {
  const now = Date.now();
  const c = cache.get(userId);
  if (c && now - c.at < CACHE_MS) return c;
  const none: Access = { role: null, workspaceId: null, fullName: null, agentCode: null, myoperatorUserId: null, at: now };
  if (!/^[0-9a-fA-F-]{36}$/.test(userId)) return none;
  const rows = await db`select role::text as role, workspace_id::text as ws, full_name, agent_code, myoperator_user_id
                        from public.profiles where id = ${userId}::uuid and active`;
  const r = rows[0];
  const role = r && (ROLES as readonly string[]).includes(r.role) ? (r.role as Role) : null;
  const hit: Access = r ? { role, workspaceId: r.ws, fullName: r.full_name, agentCode: r.agent_code, myoperatorUserId: r.myoperator_user_id, at: now } : none;
  cache.set(userId, hit);
  return hit;
}

/** Forget a cached role right away (after an admin changes it). */
export const evictAccess = (userId: string) => cache.delete(userId);
