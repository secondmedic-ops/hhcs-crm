// AI (Google Gemini) values entered in Settings > Telephony & integrations > AI call summaries (table integration_settings,
// row 'ai', system-only). Like the MyOperator values: a value saved in the app wins over the Worker secret / variable of the
// same name, an empty value falls back to it. Every AI call goes through aiEnv(), so call summaries, case briefs, the
// command bar, enquiry extraction and the MIS narrative all use the same key.
import type { Sql } from '../db';
import type { Env } from '../env';

type J = Record<string, any>;

export const AI_DEFAULT_MODEL = 'gemini-2.5-flash';

const TTL = 30_000;
let cache: { at: number; values: J } | null = null;

export function clearAiCache() { cache = null; }

/** Values saved in the app: { api_key?, model?, auto? ('on' | 'off') }. */
export async function loadAiSettings(sql: Sql): Promise<J> {
  if (cache && Date.now() - cache.at < TTL) return cache.values;
  let values: J = {};
  try {
    const [row] = await sql`select settings from integration_settings where provider = 'ai'`;
    values = (row?.settings as J) || {};
  } catch { values = {}; }
  cache = { at: Date.now(), values };
  return values;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** The Worker's env with the app's AI values laid over the secrets. */
export async function aiEnv(env: Env, sql: Sql): Promise<Env> {
  const s = await loadAiSettings(sql);
  const out: J = { ...env };
  if (text(s.api_key)) out.GEMINI_API_KEY = text(s.api_key);
  if (text(s.model)) out.GEMINI_MODEL = text(s.model);
  if (s.auto === 'on' || s.auto === 'off') out.AI_AUTO_PROCESS_CALLS = s.auto === 'on' ? 'true' : 'false';
  return out as Env;
}

/** When Gemini refuses for a reason about the key or the Google account (quota, billing, invalid key, overload), automatic
 *  summaries pause instead of failing call after call: { paused_until (ISO), reason }. Row 'ai_state'. */
export async function aiPause(sql: Sql): Promise<{ paused_until: string; reason: string } | null> {
  try {
    const [row] = await sql`select settings from integration_settings where provider = 'ai_state'`;
    const s = (row?.settings as J) || {};
    return s.paused_until && new Date(s.paused_until).getTime() > Date.now() ? { paused_until: s.paused_until, reason: s.reason || '' } : null;
  } catch { return null; }
}

export async function setAiPause(sql: Sql, seconds: number, reason: string) {
  const until = new Date(Date.now() + Math.max(30, Math.min(seconds, 24 * 3600)) * 1000).toISOString();
  await sql`insert into integration_settings (provider, settings, updated_at) values ('ai_state', ${sql.json({ paused_until: until, reason })}, now())
    on conflict (provider) do update set settings = excluded.settings, updated_at = now()`;
}

export async function clearAiPause(sql: Sql) {
  await sql`delete from integration_settings where provider = 'ai_state'`;
}

/** Summaries run by themselves after each recorded call (webhook + cron sweep). */
export const autoSummaries = (env: Env) => !!env.GEMINI_API_KEY && env.AI_AUTO_PROCESS_CALLS !== 'false';

/** For the settings screen: never the key itself, only its last 4 characters and where it comes from. */
export async function describeAi(env: Env, sql: Sql) {
  const s = await loadAiSettings(sql);
  const e = await aiEnv(env, sql);
  const key = text(e.GEMINI_API_KEY);
  return {
    key: { set: !!key, source: text(s.api_key) ? 'app' : key ? 'secret' : null, value: key ? '…' + key.slice(-4) : null },
    model: e.GEMINI_MODEL || AI_DEFAULT_MODEL,
    model_source: text(s.model) ? 'app' : 'default',
    auto: e.AI_AUTO_PROCESS_CALLS !== 'false',
  };
}
