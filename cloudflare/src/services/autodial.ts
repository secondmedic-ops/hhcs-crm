// Callback auto-dialer (runs every minute from cron).
//   1. autodial_claim() (SQL, one transaction): recovers stuck attempts, then pairs each due callback with the free,
//      available, MyOperator-linked agent who has waited longest, and writes the outbound call row.
//   2. For each pair, MyOperator agent-first click-to-call: the agent's phone rings, then the patient is bridged in.
//   3. A rejected dial goes straight back to the queue (callback_retry); an unconfirmed one waits for its webhook
//      or call-log recovery, and is never dialled twice by us.
// Settings (Settings > Telephony > Auto-dialer): on/off, retry window 30 / 45 / 60 min, attempts.
import { asSystem, type Sql } from '../db';
import type { Env } from '../env';
import { ApiError } from '../domain/errors';
import { clickToCall } from './myoperator';
import { missingCallingSettings, moEnv } from './myoperator-config';

export type Claim = { callback_id: string; call_id: string; ref: string; number: string; agent_id: string; myoperator_user_id: string };

/** opts.mo: MyOperator settings already loaded; opts.claims: pairs already claimed (the minute cron claims them in
 *  cron_minute), so no second transaction is needed. */
export async function runAutodial(env: Env, sql: Sql, opts: { mo?: Env; claims?: Claim[] } = {}): Promise<{ dialled: number; failed: number; changed: string[]; skipped?: string }> {
  const changed = new Set<string>();
  const mo = opts.mo ?? await moEnv(env, sql);
  // nothing to dial with: leave the queue as it is (agents still work it by hand)
  if (missingCallingSettings(mo).length) return { dialled: 0, failed: 0, changed: [], skipped: 'calling not configured' };

  let claims = opts.claims;
  if (!claims) {
    const r = await asSystem(sql, async (tx) => {
      const [row] = await tx`select autodial_claim() as c`;
      return (row?.c || []) as Claim[];
    });
    r.changed.forEach((t) => changed.add(t));
    claims = r.result;
  }

  let dialled = 0, failed = 0;
  for (const k of claims) {
    try {
      await clickToCall(mo, { myoperatorUserId: k.myoperator_user_id, number: k.number, referenceId: k.ref });
      dialled++;
    } catch (e) {
      const unconfirmed = e instanceof ApiError && e.status === 504;
      if (unconfirmed) {
        const r = await asSystem(sql, (tx) => tx`update calls set raw = coalesce(raw, '{}'::jsonb) || '{"dial_outcome":"unconfirmed"}'::jsonb
          where id = ${k.call_id} and status = 'ringing'`);
        r.changed.forEach((t) => changed.add(t));
        dialled++; continue;
      }  // the phone may be ringing: the webhook or call-log recovery settles it
      failed++;
      const { changed: c2 } = await asSystem(sql, async (tx) => {
        // a webhook may already have moved this call on; only a call still ringing is marked failed
        const updated = await tx`update calls set status = 'failed', ended_at = now(),
            raw = coalesce(raw, '{}'::jsonb) || ${tx.json({ dial_outcome: 'rejected', auto: true })}
          where id = ${k.call_id} and status = 'ringing' returning id`;
        if (updated.length) await tx`select callback_retry(${k.callback_id}::uuid, 'MyOperator rejected the dial')`;
      });
      c2.forEach((t) => changed.add(t));
      console.log('autodial rejected', k.callback_id, (e as Error).message);
    }
  }
  return { dialled, failed, changed: [...changed] };
}
