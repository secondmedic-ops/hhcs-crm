// Free-plan query budget (21 Oct 2026): change notes only for rows really changed (20261021100000_live_change_rows)
// and the minute cron in one statement (20261021100100_cron_minute).
import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

test('live change notes per row, cron_minute runs every step once and is system only', async () => {
  const db = new PGlite();
  try {
    const dir = join(import.meta.dirname, '../../supabase/migrations');
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));
    const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
    const ws = (await one("select id from workspaces where code='HHC'")).id;

    // every tracked table has the per-row trigger (pg_trigger.tgtype bit 1 = ROW), none is left per statement
    const trig = await one(`select count(*) filter (where (t.tgtype & 1) = 1)::int as per_row, count(*) filter (where (t.tgtype & 1) = 0)::int as per_statement
      from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where t.tgname = 'zz_note_change' and n.nspname = 'public'`);
    expect(trig.per_statement).toBe(0);
    expect(trig.per_row).toBeGreaterThan(20);

    // not callable without the system role
    await expect(db.query('select cron_minute(false)')).rejects.toThrow(/System only/);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");

    const changedBy = async (statements) => db.transaction(async (tx) => {
      for (const s of statements) await tx.query(s[0], s[1] || []);
      return (await tx.query(`select coalesce(current_setting('caredesk.changed', true), '') c`)).rows[0].c;
    });
    // an UPDATE / DELETE that matches no row notes nothing (this reloaded every open screen every minute)
    expect(await changedBy([[`update sla_timers set status = status where false`], [`delete from callbacks where false`]])).toBe('');
    // a real change is noted, once per table
    const noted = await changedBy([[`insert into callbacks(workspace_id, number, due_at) values ($1, '+919800000009', now() + interval '30 minutes')`, [ws]],
      [`update callbacks set due_at = due_at where number = '+919800000009'`]]);
    expect(noted.split(',').filter((t) => t === 'callbacks')).toHaveLength(1);

    const r = (await one('select cron_minute(false) r')).r;
    expect(r.errors).toEqual({});
    expect(r.claims).toEqual([]);
    for (const k of ['swept', 'silence', 'sla', 'prices']) expect(r).toHaveProperty(k);
    // with the auto-dialer on, the claim runs too (no agent available here, so nothing is claimed)
    const r2 = (await one('select cron_minute(true) r')).r;
    expect(r2.errors).toEqual({});
    expect(Array.isArray(r2.claims)).toBe(true);
  } finally {
    await db.close();
  }
});
