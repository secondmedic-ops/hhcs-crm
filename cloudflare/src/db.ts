// Supabase Postgres through postgres.js over Cloudflare Hyperdrive (pooled, TLS to Supabase handled by Hyperdrive).
// One short-lived connection per request, closed after the response.
//
// Two ways to run work:
//   asUser(sql, user, fn)  every screen request: one transaction, run AS caredesk_app with the user's id set, so the
//                          Row Level Security policies and the role checks inside the RPCs apply.
//   asSystem(sql, fn)      MyOperator webhooks, cron, inbound e-mail: one transaction as the database owner, marked
//                          service_role for the RPCs that check is_service().
// Both return the tables the transaction changed (see migration live_change_tracking), for the live-updates hub.
import postgres from 'postgres';
import { ApiError } from './domain/errors';
import type { Env } from './env';
import { pgArray } from './domain/query';
export { pgArray };

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
export type Db = Sql | Tx;

export const isLocalDb = (url: string) => {
  try {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** The connection string this Worker uses: Hyperdrive in production, DATABASE_URL only for a local database. */
export function databaseUrl(env: Env): string | undefined {
  if (env.DATABASE_URL && isLocalDb(env.DATABASE_URL)) return env.DATABASE_URL;
  return env.HYPERDRIVE?.connectionString;
}

export function connect(env: Env): Sql {
  const url = databaseUrl(env);
  if (!url) throw new ApiError(503, 'Database is not configured (Hyperdrive binding missing). Run SHIP.bat again.');
  return postgres(url, {
    prepare: false,
    max: 1,
    fetch_types: false,
    idle_timeout: 5,
    connect_timeout: 10,
    ssl: false,
    types: {
      // date (1082): keep the text, never shift a day through a JS Date.
      date: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
      // Arrays come back as JS arrays (type lookup is off to save a query per request, so they are named here):
      // text[] 1009, varchar[] 1015, uuid[] 2951, int4[] 1007, int8[] 1016, numeric[] 1231, bool[] 1000.
      textArray: { to: 1009, from: [1009, 1015, 2951, 1231, 1016], serialize: (x: unknown) => (Array.isArray(x) ? pgArray(x) : String(x)), parse: (x: string) => parsePgArray(x) },
      intArray: { to: 1007, from: [1007], serialize: (x: unknown) => (Array.isArray(x) ? pgArray(x) : String(x)), parse: (x: string) => parsePgArray(x).map((v) => (v == null ? v : Number(v))) },
      boolArray: { to: 1000, from: [1000], serialize: (x: unknown) => (Array.isArray(x) ? pgArray(x) : String(x)), parse: (x: string) => parsePgArray(x).map((v) => (v == null ? v : v === 't')) },
    },
    onnotice: () => {},
  });
}

/** One-dimensional Postgres array text ({a,"b c",NULL}) -> JS array of strings / null. */
export function parsePgArray(text: string): (string | null)[] {
  if (!text || text === '{}') return [];
  const out: (string | null)[] = [];
  let i = 1, cur = '', quoted = false, wasQuoted = false;
  const s = text;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '\\') { cur += s[++i]; continue; }
      if (ch === '"') { quoted = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; wasQuoted = true; continue; }
    if (ch === ',' || ch === '}') {
      out.push(!wasQuoted && cur === 'NULL' ? null : cur);
      cur = ''; wasQuoted = false;
      if (ch === '}') break;
      continue;
    }
    cur += ch;
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const changedOf = (v: unknown) => [...new Set(String(v ?? '').split(',').filter(Boolean))];
// Request-scoped: each request owns its connection. Never a global current-user value.
const staffSessions = new WeakMap<Sql, string>();
export const setStaffSession = (sql: Sql, id: string) => staffSessions.set(sql, id);
async function staffContext(sql: Sql, tx: Tx) {
  const id = staffSessions.get(sql);
  if (id) await tx`select set_config('caredesk.staff_session', ${id}, true)`;
}

export async function asUser<T>(sql: Sql, userId: string, fn: (tx: Tx) => Promise<T>): Promise<{ result: T; changed: string[] }> {
  if (!UUID.test(userId)) throw new ApiError(401, 'Please log in again (missing or expired session).');
  return sql.begin(async (tx) => {
    await staffContext(sql, tx);
    // one statement: who is asking, then become caredesk_app for the rest of this transaction
    await tx`select set_config('request.jwt.claim.sub', ${userId}, true), set_config('request.jwt.claim.role', 'authenticated', true),
                    set_config('role', 'caredesk_app', true)`;
    const result = await fn(tx);
    const [row] = await tx`select current_setting('caredesk.changed', true) as c`;
    return { result, changed: changedOf(row?.c) };
  }) as Promise<{ result: T; changed: string[] }>;
}

/** Reads only: same rules as asUser, without the changed-tables lookup (one statement fewer per request). */
export async function readAsUser<T>(sql: Sql, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(userId)) throw new ApiError(401, 'Please log in again (missing or expired session).');
  return sql.begin(async (tx) => {
    await staffContext(sql, tx);
    await tx`select set_config('request.jwt.claim.sub', ${userId}, true), set_config('request.jwt.claim.role', 'authenticated', true),
                    set_config('role', 'caredesk_app', true)`;
    return fn(tx);
  }) as Promise<T>;
}

export async function asSystem<T>(sql: Sql, fn: (tx: Tx) => Promise<T>): Promise<{ result: T; changed: string[] }> {
  return sql.begin(async (tx) => {
    await staffContext(sql, tx);
    await tx`select set_config('request.jwt.claim.role', 'service_role', true), set_config('request.jwt.claim.sub', '', true)`;
    const result = await fn(tx);
    const [row] = await tx`select current_setting('caredesk.changed', true) as c`;
    return { result, changed: changedOf(row?.c) };
  }) as Promise<{ result: T; changed: string[] }>;
}

/**
 * Every table and column the Worker's own SQL reads or writes (screens go through RLS-checked queries and are covered
 * by the views and RPCs). The rehearsal checks them against the database built from supabase/migrations.
 */
export const SCHEMA: Record<string, string[]> = {
  staff_sessions: ['id', 'workspace_id', 'supervisor_id', 'staff_id', 'expires_at', 'ended_at'],
  workspaces: ['id', 'code', 'settings'],
  profiles: ['id', 'workspace_id', 'full_name', 'email', 'phone', 'role', 'agent_code', 'myoperator_user_id', 'myoperator_extension', 'skills', 'active', 'provider_id', 'integration_only',
    'available', 'available_since', 'last_autodial_at', 'location_sharing'],
  payments: ['id', 'workspace_id', 'case_id', 'amount', 'collected_at', 'destination_account'],
  patients: ['id', 'workspace_id', 'mobile', 'email', 'full_name'],
  cases: ['id', 'workspace_id', 'patient_id', 'case_no', 'stage', 'caller_mobile', 'ai_brief', 'created_at'],
  calls: ['id', 'workspace_id', 'provider', 'session_id', 'provider_call_id', 'direction', 'customer_number', 'did_number', 'agent_id',
    'agent_name', 'department', 'status', 'started_at', 'answered_at', 'ended_at', 'ring_seconds', 'talk_seconds', 'recording_filename',
    'patient_id', 'case_id', 'disposition', 'notes', 'transcript', 'ai_summary', 'ai_sentiment', 'ai_intent', 'ai_extracted', 'ai_flags',
    'ai_processed_at', 'click_to_call_ref', 'raw', 'callback_id', 'ai_status', 'ai_error', 'ai_attempts', 'ai_started_at', 'live_transcript', 'live_transcript_started_at', 'live_transcript_completed_at',
    'duration_flag', 'callback_note', 'disposition_auto'],
  callbacks: ['id', 'workspace_id', 'call_id', 'number', 'patient_id', 'reason', 'due_at', 'status', 'assigned_to', 'last_attempt_at', 'completed_at', 'completed_by',
    'attempts', 'next_attempt_at', 'auto_dialled'],
  interactions: ['id', 'workspace_id', 'case_id', 'patient_id', 'channel', 'direction', 'actor_id', 'actor_label', 'call_id', 'summary', 'body', 'evidence', 'template_id', 'meta', 'occurred_at'],
  sla_policies: ['workspace_id', 'key', 'target_minutes'],
  templates: ['id', 'workspace_id', 'code', 'title', 'kind', 'status', 'body', 'provider_template_name'],
  services: ['id', 'workspace_id', 'code', 'name', 'active'],
  qa_reviews: ['workspace_id', 'call_id', 'agent_id', 'greeting', 'consent', 'price_accuracy', 'empathy', 'closure', 'total_pct', 'notes', 'ai_generated'],
  escalations: ['id', 'workspace_id', 'case_id', 'type', 'level', 'trigger_text', 'status', 'auto_raised'],
  webhook_events: ['event_id', 'source', 'event_type', 'payload', 'processed', 'error', 'received_at'],
  inbound_emails: ['workspace_id', 'message_id', 'from_address', 'to_address', 'subject', 'text_body', 'patient_id', 'case_id'],
  mis_snapshots: ['id', 'workspace_id', 'period', 'period_start', 'data', 'narrative', 'email_status', 'email_attempted_at', 'emailed_at', 'email_error'],
  access_log: ['workspace_id', 'user_id', 'action', 'entity', 'entity_id', 'meta'],
  integration_settings: ['provider', 'settings', 'updated_at', 'updated_by'],
  deployments: ['id', 'at', 'sha', 'subject', 'author', 'areas', 'status', 'run_url'],
};

export async function schemaProblems(sql: Sql): Promise<string[]> {
  const rows = await sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`;
  const have = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
  const problems: string[] = [];
  for (const [t, cols] of Object.entries(SCHEMA)) for (const c of cols) if (!have.has(`${t}.${c}`)) problems.push(`${t}.${c} is missing`);
  return problems;
}

/** +91XXXXXXXXXX from anything a caller or provider sends. */
export function normMobile(p: unknown): string | null {
  if (p == null || p === '') return null;
  let v: unknown = p;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    v = o.number || o.phone || o.value || `${o.country_code || ''}${o.national_number || ''}`;
  }
  const d = String(v).replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 10) return '+91' + d;
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  if (d.length === 11 && d.startsWith('0')) return '+91' + d.slice(1);
  return '+' + d;
}
