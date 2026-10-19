// MyOperator connection values entered in Settings > Telephony (table integration_settings, system-only).
// A value saved in the app wins over the Worker secret of the same name; an empty value falls back to the secret.
// Every MyOperator call goes through moEnv(), so click-to-call, recordings, WhatsApp and the webhook key all use it.
import type { Sql } from '../db';
import type { Env } from '../env';

type J = Record<string, any>;

/** The fields an admin can enter. `secret: false` fields are shown in full (they are identifiers, not credentials). */
export const MO_FIELDS = [
  { key: 'webhook_key', env: 'MYOPERATOR_WEBHOOK_KEY', label: 'Webhook key', secret: true },
  { key: 'company_id', env: 'MYOPERATOR_COMPANY_ID', label: 'Company ID', secret: false },
  { key: 'secret_token', env: 'MYOPERATOR_SECRET_TOKEN', label: 'Secret token', secret: true },
  { key: 'obd_api_key', env: 'MYOPERATOR_OBD_API_KEY', label: 'Calling API key (x-api-key)', secret: true },
  { key: 'public_ivr_id', env: 'MYOPERATOR_PUBLIC_IVR_ID', label: 'Public IVR ID', secret: false },
  { key: 'api_token', env: 'MYOPERATOR_API_TOKEN', label: 'API token (users, call logs, recordings)', secret: true },
  { key: 'caller_id', env: 'MYOPERATOR_CALLER_ID', label: 'Outgoing caller ID (optional)', secret: false },
  { key: 'region', env: 'MYOPERATOR_REGION', label: 'Region (optional)', secret: false },
  { key: 'waba_api_key', env: 'MYOPERATOR_WABA_API_KEY', label: 'WhatsApp API key (optional)', secret: true },
  { key: 'waba_phone_id', env: 'MYOPERATOR_WABA_PHONE_ID', label: 'WhatsApp phone number ID (optional)', secret: false },
] as const;
export type MoKey = (typeof MO_FIELDS)[number]['key'];

/** Calling readiness is shared by the dial endpoint and Settings; values never leave the server. */
export function missingCallingSettings(env: Env): string[] {
  return MO_FIELDS.filter((f) => ['company_id', 'secret_token', 'obd_api_key', 'public_ivr_id'].includes(f.key))
    .filter((f) => !String(env[f.env] || '').trim()).map((f) => f.label);
}

/** Presence is configuration, not proof that MyOperator accepts the credentials. */
export function wabaConfiguration(env: Env) {
  const missing = [
    !env.MYOPERATOR_COMPANY_ID?.trim() && 'Company ID',
    !env.MYOPERATOR_WABA_API_KEY?.trim() && 'WhatsApp API key',
    !env.MYOPERATOR_WABA_PHONE_ID?.trim() && 'WhatsApp phone number ID',
  ].filter((v): v is string => !!v);
  return {
    ok: false, status: missing.length ? 'missing_credentials' : 'configured', missing,
    message: missing.length ? 'Missing: ' + missing.join(', ') : 'Credentials present. Test WABA connection to verify them with MyOperator.',
  };
}

const TTL = 30_000;
let cache: { at: number; values: J } | null = null;

export function clearMoCache() { cache = null; }

/** Values saved in the app (empty object before the migration ran or when nothing was saved). */
export async function loadMoSettings(sql: Sql): Promise<J> {
  if (cache && Date.now() - cache.at < TTL) return cache.values;
  let values: J = {};
  try {
    const [row] = await sql`select settings from integration_settings where provider = 'myoperator'`;
    values = (row?.settings as J) || {};
  } catch { values = {}; }
  cache = { at: Date.now(), values };
  return values;
}

/** The Worker's env with the app's MyOperator values laid over the secrets. */
export async function moEnv(env: Env, sql: Sql): Promise<Env> {
  const s = await loadMoSettings(sql);
  const out: J = { ...env };
  for (const f of MO_FIELDS) {
    const v = typeof s[f.key] === 'string' ? s[f.key].trim() : '';
    out[f.env] = v || (typeof env[f.env] === 'string' ? env[f.env]!.trim() : '');
  }
  return out as Env;
}

/** Where each value comes from, for the settings screen. Credentials are never returned, only their last 4 characters. */
export async function describeMo(env: Env, sql: Sql) {
  const s = await loadMoSettings(sql);
  const e = env as unknown as J;
  return MO_FIELDS.map((f) => {
    const app = typeof s[f.key] === 'string' ? s[f.key].trim() : '';
    const sec = typeof e[f.env] === 'string' ? String(e[f.env]).trim() : '';
    const v = app || sec;
    return {
      key: f.key, label: f.label, secret: f.secret, set: !!v, source: app ? 'app' : sec ? 'secret' : null,
      value: !v ? null : f.secret ? '…' + v.slice(-4) : v,
    };
  });
}

export function randomKey(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return 'hhcs_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
