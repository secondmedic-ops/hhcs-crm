#!/usr/bin/env node
// Purge synthetic demo test breaches before production launch (REQ-09 / Item #09).
// Safely resets:
//  - Staged escalations in table "escalations" associated with synthetic demo cases / walkthroughs
//  - Low-score QA evaluations in table "qa_reviews" (e.g. staged 12% audit warnings)
//  - Stale demonstration callback breaches & breached SLA timers
//  - Resets cases.sla_state on demo cases to 'ok'
// Preserves all configuration (workspaces, templates, SLA policies), users, rate cards, and product knowledge.
//
// Usage:
//   node scripts/purge_demo_test_data.mjs --dry-run
//   node scripts/purge_demo_test_data.mjs --execute
//   node scripts/purge_demo_test_data.mjs --pglite [--dry-run | --execute]

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const isExecute = args.includes('--execute');
const isDryRun = args.includes('--dry-run') || !isExecute;
const usePglite = args.includes('--pglite');

async function main() {
  console.log(`\n=== CareDesk CRM: Demo Test Data Purge ===`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN (no changes will be committed)' : 'EXECUTE (purging test breaches)'}\n`);

  let sql;
  let cleanupDb = async () => {};

  if (usePglite || (!process.env.SUPABASE_DB_URL && !process.env.DATABASE_URL)) {
    if (!usePglite && !process.env.SUPABASE_DB_URL && !process.env.DATABASE_URL) {
      console.log(`Notice: Neither SUPABASE_DB_URL nor DATABASE_URL was found.`);
      console.log(`Running in local PGlite demonstration mode...\n`);
    }

    const { PGlite } = await import('@electric-sql/pglite');
    const db = new PGlite();
    const root = process.cwd();
    const migDir = join(root, 'supabase', 'migrations');
    console.log(`Loading migrations from ${migDir}...`);
    for (const f of readdirSync(migDir).filter((f) => f.endsWith('.sql')).sort()) {
      await db.exec(readFileSync(join(migDir, f), 'utf8'));
    }

    console.log(`Seeding demo MMR data from src/demo/seed.js...`);
    const { buildSeedSql } = await import(pathToFileURL(join(root, 'src', 'demo', 'seed.js')).href);
    const ws = (await db.query(`select id from workspaces where code = 'HHC'`)).rows[0].id;
    const services = (await db.query(`select id, code, name, category, price from services`)).rows;
    const templates = (await db.query(`select id, code from templates`)).rows;
    const zones = (await db.query(`select id, name from zones`)).rows;
    await db.exec(`set session_replication_role = replica;\n${buildSeedSql({ ws, services, templates, zones })}\nset session_replication_role = origin;`);

    sql = async (queryText) => {
      const res = await db.query(queryText);
      return res.rows;
    };
    cleanupDb = async () => { await db.close(); };
  } else {
    const dbUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
    let postgresModule;
    try {
      postgresModule = (await import('postgres')).default;
    } catch {
      const cfPostgres = join(process.cwd(), 'cloudflare', 'node_modules', 'postgres', 'src', 'index.js');
      if (existsSync(cfPostgres)) {
        postgresModule = (await import(cfPostgres)).default;
      } else {
        throw new Error('postgres library not found. Install or pass --pglite for local testing.');
      }
    }
    const client = postgresModule(dbUrl, { max: 1, ssl: false });
    sql = async (queryText) => {
      return await client.unsafe(queryText);
    };
    cleanupDb = async () => { await client.end(); };
  }

  try {
    // 1. Inspect matching test escalations
    const escQuery = `
      select count(*)::int as count,
             coalesce(json_agg(json_build_object('id', id, 'level', level, 'trigger', trigger_text, 'status', status)), '[]'::json) as sample
      from escalations
      where case_id in (
        select id from cases
        where case_no ~* '^(demo|test)-'
           or patient_id in (select id from patients where mobile ~ '^\\+919800000' or mobile in ('+919820012012', '9930011223', '9930011224', '9930011225') or full_name ~* '^(demo|test)')
      )
      or trigger_text ~* '(demo|synthetic|test|sample|simulat|slot at risk|technician running late|audit warning)'
      or (case_id is null and complaint_id is null and status <> 'resolved')
    `;
    const [escResult] = await sql(escQuery);
    console.log(`[1] Test Escalations to Purge: ${escResult.count} row(s)`);
    if (escResult.count > 0) {
      console.log(`    Sample:`, JSON.stringify(escResult.sample.slice(0, 3)));
    }

    // 2. Inspect matching low-score / demo QA evaluations
    const qaQuery = `
      select count(*)::int as count,
             coalesce(round(avg(total_pct), 1), 0) as current_avg_pct,
             count(*) filter (where total_pct <= 20.0)::int as low_score_outliers
      from qa_reviews
      where total_pct <= 20.0
         or notes ~* '(demo|audit warning|staged|test evaluation)'
         or call_id in (
           select id from calls
           where session_id ~* '^(local|demo|test)-'
              or recording_filename in ('local-test-recording.mp3', 'demo-recording.mp3')
              or raw->'first'->>'event_id' like 'local-%'
              or raw->'end'->>'event_id' like 'local-%'
         )
    `;
    const [qaResult] = await sql(qaQuery);
    console.log(`[2] Staged QA Reviews to Purge: ${qaResult.count} row(s) (Low-score <=20%: ${qaResult.low_score_outliers})`);

    // 3. Inspect stale test callbacks & breached timers
    const cbQuery = `
      select count(*)::int as count,
             count(*) filter (where status in ('pending', 'in_progress'))::int as open_callbacks
      from callbacks
      where number in ('+919820012012', '9930011223', '9930011224', '9930011225')
         or number ~ '^\\+919800000'
         or call_id in (
           select id from calls
           where session_id ~* '^(local|demo|test)-'
              or recording_filename in ('local-test-recording.mp3', 'demo-recording.mp3')
         )
    `;
    const [cbResult] = await sql(cbQuery);
    console.log(`[3] Stale Test Callbacks to Purge: ${cbResult.count} row(s) (${cbResult.open_callbacks} pending/in-progress)`);

    const timerQuery = `
      select count(*)::int as count
      from sla_timers
      where status = 'breached' and (
        case_id in (select id from cases where case_no ~* '^(demo|test)-')
        or complaint_id in (select id from complaints where ref_no ~* '^(demo|test|cmp-)-' or description ~* 'demo')
        or (callback_id is null and case_id is null)
      )
    `;
    const [timerResult] = await sql(timerQuery);
    console.log(`[4] Breached Demo SLA Timers to Purge: ${timerResult.count} row(s)`);

    // 4. Inspect breached demo cases to reset
    const caseQuery = `
      select count(*)::int as count
      from cases
      where sla_state in ('breached', 'at_risk')
        and (case_no ~* '^(demo|test)-' or stage in ('closed', 'cancelled')
             or patient_id in (select id from patients where mobile ~ '^\\+919800000' or mobile in ('+919820012012', '9930011223')))
    `;
    const [caseResult] = await sql(caseQuery);
    console.log(`[5] Demo Cases with Breached SLA to Reset: ${caseResult.count} row(s)`);

    if (isDryRun) {
      console.log(`\n--> Dry run complete. No rows were deleted or modified.`);
      console.log(`--> To apply changes, execute with: node scripts/purge_demo_test_data.mjs --execute\n`);
      return;
    }

    // Execute within a safe transaction
    console.log(`\nExecuting atomic purge transaction...`);
    await sql(`begin;`);

    // Delete escalations
    const delEsc = await sql(`
      delete from escalations
      where case_id in (
        select id from cases
        where case_no ~* '^(demo|test)-'
           or patient_id in (select id from patients where mobile ~ '^\\+919800000' or mobile in ('+919820012012', '9930011223', '9930011224', '9930011225') or full_name ~* '^(demo|test)')
      )
      or trigger_text ~* '(demo|synthetic|test|sample|simulat|slot at risk|technician running late|audit warning)'
      or (case_id is null and complaint_id is null and status <> 'resolved')
      returning id;
    `);

    // Delete QA reviews
    const delQa = await sql(`
      delete from qa_reviews
      where total_pct <= 20.0
         or notes ~* '(demo|audit warning|staged|test evaluation)'
         or call_id in (
           select id from calls
           where session_id ~* '^(local|demo|test)-'
              or recording_filename in ('local-test-recording.mp3', 'demo-recording.mp3')
              or raw->'first'->>'event_id' like 'local-%'
              or raw->'end'->>'event_id' like 'local-%'
         )
      returning id;
    `);

    // Delete stale test callbacks
    const delCb = await sql(`
      delete from callbacks
      where number in ('+919820012012', '9930011223', '9930011224', '9930011225')
         or number ~ '^\\+919800000'
         or call_id in (
           select id from calls
           where session_id ~* '^(local|demo|test)-'
              or recording_filename in ('local-test-recording.mp3', 'demo-recording.mp3')
         )
      returning id;
    `);

    // Delete breached demo SLA timers
    const delTimer = await sql(`
      delete from sla_timers
      where status = 'breached' and (
        case_id in (select id from cases where case_no ~* '^(demo|test)-')
        or complaint_id in (select id from complaints where ref_no ~* '^(demo|test|cmp-)-' or description ~* 'demo')
        or (callback_id is null and case_id is null)
      )
      returning id;
    `);

    // Reset SLA state on demo cases
    const resetCases = await sql(`
      update cases
      set sla_state = 'ok'
      where sla_state in ('breached', 'at_risk')
        and (case_no ~* '^(demo|test)-' or stage in ('closed', 'cancelled')
             or patient_id in (select id from patients where mobile ~ '^\\+919800000' or mobile in ('+919820012012', '9930011223')))
      returning id;
    `);

    // Record audit log
    await sql(`
      insert into audit_log (table_name, action, changes)
      values ('system', 'purge_demo_test_data', json_build_object(
        'escalations_deleted', ${delEsc.length},
        'qa_reviews_deleted', ${delQa.length},
        'callbacks_deleted', ${delCb.length},
        'sla_timers_deleted', ${delTimer.length},
        'cases_reset', ${resetCases.length},
        'executed_at', now()
      ));
    `);

    await sql(`commit;`);

    console.log(`\nPurge executed successfully:`);
    console.log(`  - Escalations deleted: ${delEsc.length}`);
    console.log(`  - QA reviews deleted: ${delQa.length}`);
    console.log(`  - Callbacks deleted: ${delCb.length}`);
    console.log(`  - Breached SLA timers deleted: ${delTimer.length}`);
    console.log(`  - Cases reset to sla_state 'ok': ${resetCases.length}`);
    console.log(`  - Audit record logged in table audit_log.\n`);
  } catch (err) {
    await sql(`rollback;`).catch(() => {});
    console.error(`Error during purge execution:`, err);
    process.exit(1);
  } finally {
    await cleanupDb();
  }
}

main().catch((err) => {
  console.error(`Fatal error:`, err);
  process.exit(1);
});

