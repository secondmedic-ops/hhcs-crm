// Settings > Users (new login) and Settings > Telephony (integration status, last webhook events).
import type { Ctx } from '../api/context';
import { ROLES, supabaseBase } from '../api/auth';
import { ApiError } from '../domain/errors';
import { asSystem, normMobile, pgArray } from '../db';

type J = Record<string, any>;

export async function createUser(c: Ctx, b: J) {
  if (!c.env.SUPABASE_SERVICE_ROLE_KEY) throw new ApiError(503, 'New logins need the Supabase service key: run START-HERE.bat and add it, or add the user in Supabase > Authentication.');
  if (!b?.email || !b?.password || !b?.full_name) throw new ApiError(400, 'Email, password and name are required', { email: 'must not be blank' });
  if (!(ROLES as readonly string[]).includes(b.role)) throw new ApiError(400, 'Unknown role');
  if (String(b.password).length < 10) throw new ApiError(400, 'Password must be at least 10 characters');
  const base = supabaseBase(c.env);
  const r = await fetch(base + '/auth/v1/admin/users', {
    method: 'POST',
    headers: { apikey: c.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${c.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: b.email, password: b.password, email_confirm: true, user_metadata: { full_name: b.full_name } }),
  });
  const u = (await r.json().catch(() => ({}))) as J;
  if (!r.ok) throw new ApiError(r.status === 422 ? 409 : 502, u.msg || u.message || 'Could not create the login');
  const { result, changed } = await asSystem(c.sql, async (tx) => {
    const [p] = await tx`insert into profiles (id, workspace_id, full_name, email, phone, role, agent_code, myoperator_user_id, myoperator_extension, skills)
      values (${u.id}, ${c.user.workspaceId}, ${b.full_name}, ${b.email}, ${normMobile(b.phone)}, ${b.role}, ${b.agent_code || null},
        ${b.myoperator_user_id || null}, ${b.myoperator_extension || null}, ${pgArray((b.skills || []).map(String))}::text[]) returning *`;
    return p;
  });
  c.changed.push(...changed);
  return result;
}

export async function webhookEvents(c: Ctx) {
  return c.sql`select event_id, source, event_type, payload, processed, error, received_at from webhook_events order by received_at desc limit 50`;
}

export async function integrations(c: Ctx) {
  const e = c.env;
  return {
    supabase: !!(e.HYPERDRIVE || e.DATABASE_URL), auth: !!e.SUPABASE_URL, telephony: !!e.MYOPERATOR_OBD_API_KEY,
    webhook: !!e.MYOPERATOR_WEBHOOK_KEY, recordings: !!e.MYOPERATOR_API_TOKEN, whatsapp: !!e.MYOPERATOR_WABA_API_KEY,
    ai: !!e.GEMINI_API_KEY, mis_email: !!(e.RESEND_API_KEY && e.MIS_RECIPIENTS), user_admin: !!e.SUPABASE_SERVICE_ROLE_KEY,
    webhook_url: (e.APP_URL || new URL(c.req.url).origin) + '/webhooks/myoperator', build: e.BUILD_SHA || 'dev',
  };
}
