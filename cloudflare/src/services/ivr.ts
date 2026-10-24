import { asSystem, connect, normMobile, type Tx } from '../db';
import type { Ctx } from '../api/context';
import type { Env } from '../env';
import { ApiError } from '../domain/errors';
import { callbackStart, decideIvr, IVR_NODES, officeHours, type IvrAction, type IvrState } from '../domain/ivr';
import { readJson } from '../api/http';
import { moEnv } from './myoperator-config';
import { findOrCreateCall, resolveWorkspace } from './myoperator';
import { notifyLive } from './live';

type Config = { enabled: boolean; flow_id: string; nodes: Record<string, string> };
const configOf = (s: any): Config => ({ enabled: s?.enabled === true, flow_id: s?.flow_id || '', nodes: s?.nodes || {} });
const missingNodes = (s: Config) => IVR_NODES.filter(k => !s.nodes[k]);
const provider = (ws: string) => 'hhcs_ivr:' + ws;

export async function ivrSettings(c: Ctx) {
  const [r] = await c.sql`select settings from integration_settings where provider = ${provider(c.user.workspaceId!)}`;
  const config = configOf(r?.settings);
  const env = await moEnv(c.env, c.sql);
  return { ...config, webhook_key_set: !!env.MYOPERATOR_WEBHOOK_KEY, missing_nodes: missingNodes(config),
    url: (c.env.APP_URL || c.url.origin).replace(/\/$/, '') + '/webhooks/myoperator/ivr',
    hours: '08:00 to 20:00 Asia/Kolkata, every day', queue_seconds: 180,
    activation: 'MyOperator node mapping and a real inbound call test are required. Saving does not publish the provider flow.' };
}

export async function saveIvrSettings(c: Ctx, b: any) {
  if (!b || typeof b.enabled !== 'boolean' || typeof b.flow_id !== 'string' || !b.nodes || Array.isArray(b.nodes) || typeof b.nodes !== 'object') throw new ApiError(400, 'Supply enabled, flow_id and nodes');
  const s: Config = { enabled: b.enabled, flow_id: b.flow_id.trim(), nodes: {} };
  const validId = (v: string) => /^[a-zA-Z0-9_.:-]{1,160}$/.test(v);
  for (const k of IVR_NODES) {
    if (typeof b.nodes[k] !== 'string') throw new ApiError(400, 'Node IDs must be text');
    const v = b.nodes[k].trim();
    if (v && !validId(v)) throw new ApiError(400, 'Invalid node ID');
    s.nodes[k] = v;
  }
  if (s.flow_id && !validId(s.flow_id)) throw new ApiError(400, 'Invalid flow ID');
  const env = await moEnv(c.env, c.sql);
  if (s.enabled && (!s.flow_id || missingNodes(s).length || !env.MYOPERATOR_WEBHOOK_KEY)) throw new ApiError(400, 'Configure the webhook key, flow ID and every node before enabling');
  // System-only settings store: access is restricted to TECH at the route boundary, like MyOperator settings.
  const { changed } = await asSystem(c.sql, async tx => {
    await tx`insert into integration_settings(provider, settings, updated_by, updated_at)
      values (${provider(c.user.workspaceId!)}, ${tx.json(s)}, ${c.user.id}::uuid, now())
      on conflict(provider) do update set settings = excluded.settings, updated_by = excluded.updated_by, updated_at = now()`;
    await tx`insert into access_log(workspace_id, user_id, action, entity, meta)
      values (${c.user.workspaceId}::uuid, ${c.user.id}::uuid, 'settings_changed', 'hhcs_ivr', ${tx.json({ enabled: s.enabled })})`;
  });
  c.changed.push(...changed);
  return ivrSettings(c);
}

async function freeCse(tx: Tx, ws: string) {
  // Availability is advisory: the MyOperator homecare department is the authoritative live queue/agent selector.
  const [r] = await tx`select exists(select 1 from profiles p where p.workspace_id = ${ws}::uuid
    and p.active and p.available and nullif(btrim(p.myoperator_user_id), '') is not null
    and p.role in ('agent','telecaller','coordinator','supervisor')
    and not exists(select 1 from calls k where k.agent_id = p.id and k.status in ('ringing','answered'))
    and not exists(select 1 from calls k where k.agent_id = p.id and k.status = 'completed'
      and k.raw->>'customer_connected' = 'true' and k.disposition is null)
    and not exists(select 1 from callbacks b where b.assigned_to = p.id and b.status = 'in_progress')) as free`;
  return !!r?.free;
}

/** Input-node adapter contract is documented in docs/IVR-ROUTING.md; this is not an after-call webhook. */
export async function handleIvr(req: Request, env0: Env, exec: ExecutionContext) {
  const sql = connect(env0);
  try {
    const env = await moEnv(env0, sql);
    if (!env.MYOPERATOR_WEBHOOK_KEY) throw new ApiError(503, 'IVR webhook key is not configured');
    if (req.headers.get('x-webhook-key') !== env.MYOPERATOR_WEBHOOK_KEY) throw new ApiError(401, 'Unauthorized');
    const b = await readJson(req);
    const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(v);
    if (!b || !id(b.session_id) || !id(b.request_id) || !['entry','menu','queue','after_hours','callback_offer'].includes(b.step)
      || (b.digit != null && !/^[0-9#*]?$/.test(String(b.digit)))) throw new ApiError(400, 'Invalid IVR input');
    const number = normMobile(b.customer_number);
    if (!number || !/^\+\d{8,15}$/.test(number)) throw new ApiError(400, 'A callable customer number is required');
    const { result, changed } = await asSystem(sql, async tx => {
      const ws = await resolveWorkspace(tx, env, b.did_number);
      const [r] = await tx`select settings from integration_settings where provider = ${provider(ws)}`;
      const cfg = configOf(r?.settings);
      if (!cfg.enabled || !cfg.flow_id || missingNodes(cfg).length) throw new ApiError(503, 'IVR is not enabled and mapped');
      const now = new Date();
      const call = await findOrCreateCall(tx, { ws, session: b.session_id, customer: number, direction: 'inbound',
        did: normMobile(b.did_number), startedAt: now.toISOString(), first: { ivr: true } });
      if (call.direction !== 'inbound' || call.customer_number !== number) throw new ApiError(409, 'IVR session does not match the caller');
      const state: IvrState = call.raw?.ivr || { afterHours: !officeHours(now) };
      let action: IvrAction;
      if (state.lastRequest === b.request_id && state.lastAction) action = state.lastAction;
      else {
        if (!call.raw?.ivr && b.step !== 'entry') throw new ApiError(409, 'Start with entry');
        if (call.ended_at && !state.terminal) throw new ApiError(409, 'Call has already ended');
        let next: IvrAction | 'callback';
        try { next = decideIvr(state, b.step, String(b.digit ?? ''), await freeCse(tx, ws), now.getTime()); }
        catch { throw new ApiError(409, 'Unexpected IVR step'); }
        if (next === 'callback') {
          // One request per call, even when the caller presses twice or the provider retries concurrently.
          let [cb] = await tx`select id from callbacks where workspace_id = ${ws}::uuid and call_id = ${call.id}::uuid limit 1`;
          if (!cb) {
            const start = callbackStart(now);
            const [pol] = await tx`select target_minutes from sla_policies where workspace_id = ${ws}::uuid and key = 'missed_callback'`;
            const [ad] = await tx`select autodial_cfg(${ws}::uuid) as cfg`;
            const minutes = ad?.cfg?.enabled ? Number(ad.cfg.buffer_minutes) : Number(pol?.target_minutes || 10);
            [cb] = await tx`insert into callbacks(workspace_id, call_id, number, patient_id, reason, due_at, notes)
              values (${ws}::uuid, ${call.id}::uuid, ${number}, ${call.patient_id}, 'requested',
                ${new Date(start.getTime() + minutes * 60_000).toISOString()}::timestamptz,
                ${state.afterHours ? 'IVR: after-hours callback, next office opening' : 'IVR: caller requested callback after queue wait'}) returning id`;
            // The existing insert trigger schedules immediately; move after-hours requests to the next opening.
            await tx`update callbacks set due_at = ${new Date(start.getTime() + minutes * 60_000).toISOString()}::timestamptz,
              next_attempt_at = ${ad?.cfg?.enabled ? start.toISOString() : null}::timestamptz where id = ${cb.id}::uuid`;
          }
          state.callbackId = cb.id;
          action = 'callback_confirm';
          state.terminal = action;
        } else action = next;
        if (action !== state.lastAction) state.retries = 0;
        if (['information','billing','emergency','voicemail'].includes(action)) state.terminal = action;
        // homecare remains nonterminal: a provider busy/no-answer exit must be able to return to queue.
        state.lastRequest = b.request_id; state.lastAction = action;
        await tx`update calls set raw = coalesce(raw, '{}'::jsonb) || ${tx.json({ ivr: state })} where id = ${call.id}::uuid`;
      }
      return { flow_id: cfg.flow_id, target_node_id: cfg.nodes[action], action, callback_id: state.callbackId || null,
        sms_status: state.callbackId ? 'provider_pending' : null };
    });
    notifyLive(env0, exec, changed);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } finally { exec.waitUntil(sql.end({ timeout: 2 }).catch(() => {})); }
}
