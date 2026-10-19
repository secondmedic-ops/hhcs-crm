import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');
const migration = '20261019120000_payment_destination_accounts.sql';

test('payment destinations: upgrade, compatibility, validation, audit and scoped MIS', async () => {
  const db = new PGlite();
  try {
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql') && f < migration).sort()) {
      await db.exec(readFileSync(join(dir, f), 'utf8'));
    }
    const ws = (await db.query("select id from workspaces where code='HHC'")).rows[0].id;
    const user = 'a1111111-1111-4111-8111-111111111111';
    await db.query("insert into profiles(id, workspace_id, full_name, role) values ($1,$2,'Test supervisor','supervisor')", [user, ws]);
    async function asUser(sql, params = []) {
      await db.query("select set_config('request.jwt.claim.sub',$1,false), set_config('request.jwt.claim.role','authenticated',false)", [user]);
      await db.exec('set role caredesk_app');
      try { return await db.transaction(async tx => (await tx.query(sql, params)).rows); }
      finally { await db.exec('reset role'); }
    }
    const [{ r: enquiry }] = await asUser('select create_enquiry($1::jsonb) r', [JSON.stringify({
      patient: { full_name: 'Test patient', mobile: '9811122233', address: 'Test address', pincode: '400050' },
      services_requested: 'ECG at home', consent: true,
    })]);
    const cid = enquiry.case_id;
    // Payment saved before the upgrade is backfilled without changing its amount.
    const [{ id: legacy }] = await asUser("select record_payment($1,100.25,'upi','LEGACY') id", [cid]);
    const sql = readFileSync(join(dir, migration), 'utf8');
    await db.exec(sql);
    await db.exec(sql); // reapplying is harmless, including function overloads and constraints
    expect((await db.query('select destination_account, amount::text from payments where id=$1', [legacy])).rows[0])
      .toEqual({ destination_account: 'HHC_HINDUJA', amount: '100.25' });

    await asUser("select record_payment(p_case => $1, p_amount => 200.50, p_mode => 'card', p_txn => 'ESCROW', p_account => 'HHC_SECONDMEDIC')", [cid]);
    await asUser("select record_payment($1,50.10,'upi','DIRECT','HHC_HINDUJA')", [cid]);
    await asUser("select record_payment($1,10.15,'upi','OLD-FOUR-ARGS')", [cid]);
    await asUser("select record_payment($1,5.05,'upi')", [cid]);
    await asUser("select record_payment($1,-20.05,'refund','REFUND','HHC_SECONDMEDIC')", [cid]);
    for (const account of ['INVALID', null]) {
      await expect(asUser("select record_payment($1,1,'upi',null,$2)", [cid, account])).rejects.toThrow('Choose a valid bank account');
    }
    await expect(db.query("insert into payments(workspace_id,case_id,amount,mode,destination_account) values ($1,$2,1,'upi','INVALID')", [ws, cid]))
      .rejects.toThrow('payments_destination_account_check');
    await expect(db.query("insert into payments(workspace_id,case_id,amount,mode,destination_account) values ($1,$2,1,'upi',null)", [ws, cid]))
      .rejects.toThrow('not-null');
    await expect(asUser("select record_payment($1,1,'cash',null,'HHC_SECONDMEDIC')", [cid]))
      .rejects.toThrow('Cash collection is not enabled');
    await db.query("update profiles set role='admin' where id=$1", [user]);
    await expect(asUser("select record_payment($1,1,'upi',null,'HHC_SECONDMEDIC')", [cid])).rejects.toThrow('Not allowed');
    await db.query("update profiles set role='supervisor' where id=$1", [user]);
    expect(Number((await db.query('select amount_collected from cases where id=$1', [cid])).rows[0].amount_collected)).toBe(346);
    expect(Number((await db.query("select count(*) n from audit_log where table_name='payments' and action='insert'")).rows[0].n)).toBe(6);
    expect(Number((await db.query("select count(*) n from audit_log where table_name='payments' and action='insert' and actor_id=$1", [user])).rows[0].n)).toBe(6);

    // Both destinations include the start of an IST day and exclude the following midnight.
    await db.query("update payments set collected_at='2026-10-18 18:30:00+00' where case_id=$1", [cid]);
    await db.query(`insert into payments(workspace_id,case_id,amount,mode,destination_account,collected_at) values
      ($1,$2,999,'upi','HHC_HINDUJA','2026-10-18 18:29:59+00'),
      ($1,$2,999,'upi','HHC_SECONDMEDIC','2026-10-19 18:30:00+00')`, [ws, cid]);
    const otherWs = (await db.query("insert into workspaces(code,name,brand_name) values ('OTHER','Other workspace','Other') returning id")).rows[0].id;
    await db.query("insert into payments(workspace_id,case_id,amount,mode,destination_account,collected_at) values ($1,$2,999,'upi','HHC_SECONDMEDIC','2026-10-19 00:00:00+00')", [otherWs, cid]);
    const [{ r }] = await asUser("select mis_report('2026-10-19','2026-10-19') r");
    expect(r.collections.by_account).toEqual({ HHC_HINDUJA: 165.55, HHC_SECONDMEDIC: 180.45 });
    expect(r.collections.collected).toBe(346);
    expect(r.collections.count).toBe(6);
    expect(r.collections.by_mode).toEqual({ upi: 165.55, card: 200.5, refund: -20.05 });
    const [{ r: empty }] = await asUser("select mis_report('2026-10-21','2026-10-21') r");
    expect(empty.collections.by_account).toEqual({});
    expect(empty.collections.collected).toBe(0);

    // Scheduled packs use the same aggregation as the live MIS RPC.
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    await db.query("select generate_mis('daily','2026-10-19','2026-10-19')");
    const snapshot = (await db.query("select data from mis_snapshots where workspace_id=$1 and period_start='2026-10-19'", [ws])).rows[0];
    expect(snapshot.data.collections.by_account).toEqual(r.collections.by_account);
  } finally { await db.close(); }
});
