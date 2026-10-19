#!/usr/bin/env node
// scripts/test_callback_flow_simulation.mjs
// ==============================================================================
// CareDesk CRM - Telephony QA Automation & Callback Flow Simulation
//
// Implements the canonical 10-step live verification suite defined in
// docs/CALLBACKS.md (lines 33-51) using mock/staging MyOperator webhooks:
//   Step 1: Telephony configuration, autodialer settings & agent-first campaign
//   Step 2: Scheduler, webhook ingress pipeline & idempotent delivery
//   Step 3: Test agent availability & MyOperator account link
//   Step 4: Simulate missed inbound call (and abandoned call)
//   Step 5: Webhook deduplication & single callback verification
//   Step 6: Queue creation with initial delay & SLA scheduling
//   Step 7: Cron sweep & free agent selection
//   Step 8: Simulate agent-first answer (verify it does NOT mark Reached)
//   Step 9: Simulate customer leg answer (verify transition to Reached & SLA met)
//   Step 10: Call completion, close callback with outcome 'Resolved' & teardown
//
// Usage:
//   node scripts/test_callback_flow_simulation.mjs [--verbose] [--report]
// ==============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// --- CLI Arguments & Settings ---
const args = process.argv.slice(2);
const isVerbose = args.includes('--verbose') || args.includes('-v');
const isHelp = args.includes('--help') || args.includes('-h');

if (isHelp) {
  console.log(`
CareDesk CRM Callback Flow Simulation Runner
Usage: node scripts/test_callback_flow_simulation.mjs [options]

Options:
  --verbose, -v   Print full SQL queries, payloads, and state diffs
  --report        Save markdown execution report to artifacts/docs
  --help, -h      Show this help message
`);
  process.exit(0);
}

// --- Assertion Framework ---
class TestReporter {
  constructor() {
    this.steps = [];
    this.currentStep = null;
    this.totalAssertions = 0;
    this.passedAssertions = 0;
    this.failedAssertions = 0;
    this.startTime = Date.now();
  }

  startStep(number, title, description) {
    this.currentStep = {
      number,
      title,
      description,
      assertions: [],
      passed: true,
      startTime: Date.now(),
    };
    this.steps.push(this.currentStep);
    console.log(`\n\x1b[1m\x1b[36m[Step ${number}] ${title}\x1b[0m`);
    if (description) console.log(`  \x1b[90m${description}\x1b[0m`);
  }

  assert(condition, message, details = null) {
    this.totalAssertions++;
    const passed = Boolean(condition);
    if (passed) {
      this.passedAssertions++;
      console.log(`  \x1b[32m✓ PASS:\x1b[0m ${message}`);
      if (isVerbose && details) {
        console.log(`    \x1b[90m${typeof details === 'object' ? JSON.stringify(details) : details}\x1b[0m`);
      }
    } else {
      this.failedAssertions++;
      this.currentStep.passed = false;
      console.error(`  \x1b[31m✗ FAIL:\x1b[0m ${message}`);
      if (details) {
        console.error(`    \x1b[33mDetails:\x1b[0m`, details);
      }
    }
    this.currentStep.assertions.push({ message, passed, details });
    return passed;
  }

  endStep() {
    if (this.currentStep) {
      this.currentStep.durationMs = Date.now() - this.currentStep.startTime;
    }
  }

  generateReport() {
    const duration = ((Date.now() - this.startTime) / 1000).toFixed(2);
    console.log('\n' + '='.repeat(80));
    console.log('\x1b[1m\x1b[37mCAREDESK TELEPHONY QA AUTOMATION - TEST EXECUTION REPORT\x1b[0m');
    console.log('='.repeat(80));
    console.log(`Execution Duration : ${duration}s`);
    console.log(`Total Steps Tested : ${this.steps.length}`);
    console.log(`Total Assertions   : ${this.totalAssertions}`);
    console.log(`Passed Assertions  : \x1b[32m${this.passedAssertions}\x1b[0m`);
    console.log(`Failed Assertions  : ${this.failedAssertions > 0 ? `\x1b[31m${this.failedAssertions}\x1b[0m` : '\x1b[32m0\x1b[0m'}`);
    console.log('-'.repeat(80));

    console.log('\x1b[1mStep Summary Table:\x1b[0m');
    console.log(
      'Step'.padEnd(8) +
      'Status'.padEnd(10) +
      'Passed/Total'.padEnd(16) +
      'Step Title'
    );
    console.log('-'.repeat(80));

    for (const s of this.steps) {
      const statusStr = s.passed ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
      const countsStr = `${s.assertions.filter((a) => a.passed).length}/${s.assertions.length}`;
      console.log(
        `Step ${s.number}`.padEnd(8) +
        statusStr.padEnd(19) +
        countsStr.padEnd(16) +
        s.title
      );
    }
    console.log('='.repeat(80));

    if (this.failedAssertions === 0) {
      console.log(`\x1b[1m\x1b[32m🎉 ALL ${this.steps.length} VERIFICATION STEPS PASSED SUCCESSFULLY!\x1b[0m\n`);
    } else {
      console.log(`\x1b[1m\x1b[31m❌ SIMULATION FAILED WITH ${this.failedAssertions} ASSERTION ERROR(S).\x1b[0m\n`);
    }

    // Generate markdown report
    const mdLines = [
      '# CareDesk Telephony QA Automation: Callback Flow Simulation Report',
      '',
      `**Generated:** ${new Date().toISOString()}  `,
      `**Duration:** ${duration}s  `,
      `**Suite:** 10-Step Canonical Telephony Verification Suite ([docs/CALLBACKS.md](file:///c:/Users/DELL/Documents/hhcs-crm/docs/CALLBACKS.md#L33-L51))  `,
      `**Result:** ${this.failedAssertions === 0 ? '✅ **ALL ASSERTIONS PASSED**' : '❌ **FAILURES DETECTED**'} (${this.passedAssertions}/${this.totalAssertions} assertions passed)  `,
      '',
      '---',
      '',
      '## Executive Summary',
      '',
      '| Step # | Verification Step | Assertions | Status | Execution Time |',
      '| :---: | :--- | :---: | :---: | :---: |',
    ];

    for (const s of this.steps) {
      const statusIcon = s.passed ? '✅ PASS' : '❌ FAIL';
      const count = `${s.assertions.filter((a) => a.passed).length}/${s.assertions.length}`;
      mdLines.push(`| **Step ${s.number}** | ${s.title} | ${count} | ${statusIcon} | ${s.durationMs || 0}ms |`);
    }

    mdLines.push('');
    mdLines.push('---');
    mdLines.push('');
    mdLines.push('## Detailed Telephony Lifecycle Flow (Mermaid)');
    mdLines.push('');
    mdLines.push('```mermaid');
    mdLines.push('sequenceDiagram');
    mdLines.push('    autonumber');
    mdLines.push('    participant C as Customer / Patient');
    mdLines.push('    participant MO as MyOperator Vendor');
    mdLines.push('    participant CRM as CareDesk Worker / DB');
    mdLines.push('    participant AG as CareDesk Agent (mo-a07)');
    mdLines.push('');
    mdLines.push('    Note over C,CRM: Step 4: Missed Call Ingestion');
    mdLines.push('    C->>MO: Inbound Call (+918049368621)');
    mdLines.push('    MO-->>C: Ringing (25s, unanswered)');
    mdLines.push('    MO->>CRM: Webhook call.end (status: missed)');
    mdLines.push('    CRM->>CRM: Insert callback (pending, initial_delay: +30m)');
    mdLines.push('    CRM->>CRM: Start SLA Timer (missed_callback, running)');
    mdLines.push('');
    mdLines.push('    Note over CRM,AG: Step 7: Scheduler Sweep & Auto-Dial');
    mdLines.push('    CRM->>CRM: autodial_claim() at eligible_at');
    mdLines.push('    CRM->>AG: Lock available agent (A-07 / mo-a07)');
    mdLines.push('    CRM->>MO: Click-to-call OBD request');
    mdLines.push('    CRM->>CRM: Status -> in_progress, attempt = 1');
    mdLines.push('');
    mdLines.push('    Note over MO,CRM: Step 8: Agent-First Answer');
    mdLines.push('    MO->>AG: Ring Agent Leg');
    mdLines.push('    AG-->>MO: Agent Answers (ANSWER)');
    mdLines.push('    MO->>CRM: Webhook call.answered (leg: agent only)');
    mdLines.push('    CRM->>CRM: Call -> answered; Callback STAYS in_progress (NOT Reached)');
    mdLines.push('');
    mdLines.push('    Note over C,CRM: Step 9: Customer Leg Answer & SLA Met');
    mdLines.push('    MO->>C: Bridge & Ring Customer Leg (+919811199991)');
    mdLines.push('    C-->>MO: Customer Answers (ANSWER)');
    mdLines.push('    MO->>CRM: Webhook call.answered (legs: agent + customer)');
    mdLines.push('    CRM->>CRM: callback_connected(); Status -> reached');
    mdLines.push('    CRM->>CRM: SLA Timer -> met; pending count drops live');
    mdLines.push('');
    mdLines.push('    Note over C,AG: Step 10: Call End & Outcome Closure');
    mdLines.push('    C->>AG: Conversation (>20s duration)');
    mdLines.push('    MO->>CRM: Webhook call.end (completed, talk: 95s)');
    mdLines.push('    CRM->>CRM: callback_call_ended(); Status STAYS reached');
    mdLines.push('    AG->>CRM: callback_close(id, outcome: "resolved")');
    mdLines.push('    CRM->>CRM: Status -> done, outcome -> resolved, interaction logged');
    mdLines.push('```');
    mdLines.push('');
    mdLines.push('---');
    mdLines.push('');
    mdLines.push('## Step-by-Step Assertion Breakdown');
    mdLines.push('');

    for (const s of this.steps) {
      mdLines.push(`### Step ${s.number}: ${s.title}`);
      if (s.description) mdLines.push(`*${s.description}*  `);
      mdLines.push('');
      for (const a of s.assertions) {
        mdLines.push(`- ${a.passed ? '✅' : '❌'} ${a.message}`);
      }
      mdLines.push('');
    }

    const reportContent = mdLines.join('\n');
    const reportPath = path.join(process.cwd(), 'docs', 'CALLBACK_FLOW_TEST_REPORT.md');
    try {
      fs.writeFileSync(reportPath, reportContent, 'utf8');
      console.log(`\x1b[36mExecution report saved to:\x1b[0m ${reportPath}\n`);
    } catch (e) {
      console.error('Failed to write report file:', e.message);
    }

    return {
      durationSeconds: duration,
      steps: this.steps,
      totalAssertions: this.totalAssertions,
      passedAssertions: this.passedAssertions,
      failedAssertions: this.failedAssertions,
      isSuccess: this.failedAssertions === 0,
    };
  }
}

// --- Helpers for Normalization & Webhook Emulation ---
function normMobile(num) {
  if (!num) return null;
  const digits = String(num).replace(/\D/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '+91' + digits.slice(1);
  return digits ? '+' + digits : null;
}

const toIso = (v) => {
  if (v == null || v === '') return null;
  let d;
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    d = new Date(n < 1e12 ? n * 1000 : n);
  } else d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
};

const customerLegs = (legs, number) =>
  legs.filter(
    (l) =>
      /customer|client/i.test(String(l.type || l.leg_type || '')) ||
      (!!number && normMobile(l.phone_number || l.number) === number)
  );

const legsAnswered = (legs) =>
  legs.some(
    (l) =>
      /^(answer|answered|connected|completed|success)$/i.test(l.dial_status || l.status || '') ||
      !!l.answered_at ||
      Number(l.talk_duration || 0) > 0
  );

// --- In-Memory Database & Test Harness ---
async function runTelephonySimulation() {
  const reporter = new TestReporter();

  // 1. Initialize PGlite database and run all migrations
  console.log('\x1b[1mInitializing CareDesk CRM PGlite test environment...\x1b[0m');
  const db = new PGlite();
  const migrationsDir = path.join(process.cwd(), 'supabase', 'migrations');
  const sqlFiles = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const f of sqlFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    await db.exec(sql);
  }
  console.log(`Applied ${sqlFiles.length} database migrations.\n`);

  // 2. Fetch workspace and provision test users
  const wsRow = (await db.query(`select id, settings from workspaces where code='HHC'`)).rows[0];
  const wsId = wsRow.id;

  const users = {
    agent: '11111111-1111-1111-1111-111111111111',
    sup: '33333333-3333-3333-3333-333333333333',
    admin: '66666666-6666-6666-6666-666666666666',
  };

  await db.query(
    `insert into profiles (id, workspace_id, full_name, role, agent_code, myoperator_user_id, available)
     values
       ($1, $2, 'A-07 Advisor', 'agent', 'A-07', 'mo-a07', false),
       ($3, $2, 'Supervisor Priya', 'supervisor', 'S-01', 'mo-s01', false),
       ($4, $2, 'Admin Vikram', 'admin', 'AD-01', null, false)
     on conflict (id) do update set
       role = excluded.role,
       agent_code = excluded.agent_code,
       myoperator_user_id = excluded.myoperator_user_id,
       available = excluded.available`,
    [users.agent, wsId, users.sup, users.admin]
  );

  // Helper to run queries as a specific authenticated user
  async function asUser(userKey, sql, params = []) {
    await db.exec('reset role');
    await db.query(
      `select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)`,
      [users[userKey]]
    );
    await db.exec('set role caredesk_app');
    try {
      return await db.transaction(async (tx) => (await tx.query(sql, params)).rows);
    } finally {
      await db.exec('reset role');
    }
  }

  // Helper to run queries as system role (cron, background, webhooks)
  async function asSystem(sql, params = []) {
    await db.exec('reset role');
    await db.query(
      `select set_config('request.jwt.claim.role', 'service_role', false), set_config('request.jwt.claim.sub', '', false)`
    );
    try {
      return (await db.query(sql, params)).rows;
    } finally {
      await db.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);
    }
  }

  // Webhook Processor (reproducing CareDesk cloudflare/src/services/myoperator.ts logic)
  async function dispatchMockWebhook(event) {
    const eventId = String(event.event_id || `${event.event_type}:${event.session_id}:${event.timestamp || Date.now()}`);
    const payload = event.payload || event;

    // 1. Idempotency store
    const fresh = await asSystem(
      `insert into webhook_events (event_id, source, event_type, payload)
       values ($1, 'myoperator', $2, $3::jsonb)
       on conflict do nothing returning event_id`,
      [eventId, event.event_type || null, JSON.stringify(payload)]
    );

    if (!fresh.length) {
      return { stored: false, applied: false, reason: 'duplicate_event' };
    }

    // 2. Process event
    const direction = /out/i.test(event.direction || payload.direction || '') ? 'outbound' : 'inbound';
    const customer = normMobile(event.customer_identifier || payload.customer_number || payload.caller_number);
    const did = normMobile(payload.did_number || payload.virtual_number || event.system_identifier || '+918049368621');
    const session = String(event.session_id || payload.session_id || eventId);
    const refId = payload.client_ref_id || payload.ref_id || event.client_ref_id;

    // Find or create call
    let callRows = await asSystem(
      `select * from calls where provider = 'myoperator' and workspace_id = $1
       and (session_id = $2 or ($3::text is not null and click_to_call_ref = $3::text)) limit 1`,
      [wsId, session, refId || null]
    );

    let call = callRows[0];
    if (!call) {
      const insCall = await asSystem(
        `insert into calls (workspace_id, provider, session_id, direction, customer_number, did_number, status, started_at, click_to_call_ref)
         values ($1, 'myoperator', $2, $3, $4, $5, 'ringing', $6, $7)
         returning *`,
        [wsId, session, direction, customer, did, toIso(payload.started_at || event.timestamp) || new Date().toISOString(), refId || null]
      );
      call = insCall[0];
    }

    const legs = payload.legs || event.legs || [];

    // Match agent if present
    const agentCandidate = legs.map((l) => l.agent?.uuid || l.user_id).filter(Boolean)[0] || payload.agent?.uuid;
    if (agentCandidate && !call.agent_id) {
      const [matched] = await asSystem(
        `select id, full_name from profiles where workspace_id = $1 and myoperator_user_id = $2 limit 1`,
        [wsId, String(agentCandidate)]
      );
      if (matched) {
        await asSystem(`update calls set agent_id = $1, agent_name = $2 where id = $3`, [matched.id, matched.full_name, call.id]);
        call.agent_id = matched.id;
        call.agent_name = matched.full_name;
      }
    }

    switch (event.event_type) {
      case 'call.initiated': {
        // Handled by findOrCreateCall (ringing)
        break;
      }
      case 'call.answered': {
        if (!['ringing', 'answered'].includes(call.status)) break;

        const custLegs = customerLegs(legs, call.customer_number);
        const hasCustomerAnswer = call.direction === 'inbound' || legsAnswered(custLegs);

        const leg = (call.direction === 'outbound' ? custLegs : legs).find((l) => l.answered_at) || legs[0] || {};
        const answeredAt = toIso(leg.answered_at || event.timestamp) || new Date().toISOString();

        await asSystem(
          `update calls set status = 'answered',
           answered_at = case when $1::boolean then $2::timestamptz else answered_at end,
           ring_seconds = coalesce($3, ring_seconds)
           where id = $4`,
          [hasCustomerAnswer, answeredAt, Number(leg.ring_duration || payload.ring_duration) || 0, call.id]
        );

        if (hasCustomerAnswer) {
          await asSystem(
            `update calls set raw = coalesce(raw, '{}'::jsonb) || '{"customer_connected":true}'::jsonb where id = $1`,
            [call.id]
          );
          if (call.direction === 'outbound') {
            await asSystem(`select callback_connected($1::uuid)`, [call.id]);
          }
        }
        break;
      }
      case 'call.end': {
        if (!['ringing', 'answered'].includes(call.status)) break;
        const custLegs = customerLegs(legs, call.customer_number);
        const answered =
          call.direction === 'outbound'
            ? call.raw?.customer_connected === true || legsAnswered(custLegs)
            : call.status === 'answered' || legsAnswered(legs) || /^(answer|answered|completed|connected)$/i.test(payload.status || '');

        const abandoned = /abandon|hangup_in_ivr|ivr/i.test(`${payload.status} ${payload.category}`);
        const finalStatus = answered ? 'completed' : call.direction === 'outbound' ? 'failed' : abandoned ? 'abandoned' : 'missed';
        const endedAt = toIso(payload.ended_at || event.timestamp) || new Date().toISOString();
        const talkLegs = call.direction === 'outbound' ? custLegs : legs;
        const talk = talkLegs.filter((l) => l.talk_duration != null).map((l) => Number(l.talk_duration));
        const talkDur = answered
          ? (talk.length ? (call.direction === 'outbound' ? Math.max(...talk) : talk.reduce((sum, n) => sum + n, 0)) : Number(payload.talk_duration || 0))
          : 0;

        await asSystem(
          `update calls set status = $1, ended_at = $2::timestamptz, talk_seconds = $3,
           ring_seconds = coalesce(ring_seconds, $4)
           where id = $5`,
          [finalStatus, endedAt, talkDur, Number(payload.ring_duration || legs[0]?.ring_duration) || 25, call.id]
        );

        // Inbound missed/abandoned -> callback insertion
        if (['missed', 'abandoned'].includes(finalStatus) && call.direction === 'inbound' && call.customer_number) {
          const originCheck = await asSystem(`select id from callbacks where workspace_id = $1 and call_id = $2 limit 1`, [wsId, call.id]);
          if (!originCheck.length) {
            const pendingCheck = await asSystem(
              `select id from callbacks where workspace_id = $1 and number = $2 and status in ('pending','in_progress') limit 1`,
              [wsId, call.customer_number]
            );
            if (!pendingCheck.length) {
              const due = new Date(Date.now() + 10 * 60000).toISOString();
              await asSystem(
                `insert into callbacks (workspace_id, call_id, number, patient_id, reason, due_at)
                 values ($1, $2, $3, $4, $5, $6::timestamptz)`,
                [wsId, call.id, call.customer_number, call.patient_id || null, finalStatus, due]
              );
            }
          }
        }

        // Outbound callback call ended
        if (call.direction === 'outbound' && call.callback_id) {
          await asSystem(`select callback_call_ended($1::uuid)`, [call.id]);
        }
        break;
      }
    }

    await asSystem(`update webhook_events set processed = true where event_id = $1`, [eventId]);
    return { stored: true, applied: true, eventId };
  }

  // ============================================================================
  // STEP 1: Confirm Telephony Configuration, Autodialer Settings & Campaign
  // (docs/CALLBACKS.md #1)
  // ============================================================================
  reporter.startStep(
    1,
    'Confirm required MyOperator settings, initial delay, window & Agent-first campaign',
    'Validates workspace autodial configuration, initial delay settings, buffer window, and campaign rules.'
  );

  // Set workspace autodialer to Enabled, 30 min initial delay, 30 min buffer, 3 attempts
  const [cfg] = await asUser('sup', `select set_autodial(true, 30, 3, 30) as r`);
  reporter.assert(cfg.r.enabled === true, 'Autodialer is enabled on workspace', cfg.r);
  reporter.assert(cfg.r.initial_delay_minutes === 30, 'Initial callback delay configured to 30 minutes', cfg.r);
  reporter.assert(cfg.r.buffer_minutes === 30, 'Retry/callback window configured to 30 minutes', cfg.r);
  reporter.assert(cfg.r.max_attempts === 3, 'Maximum dial attempts set to 3', cfg.r);

  // Check DID helpline numbers in workspace
  const [wsCheck] = await asSystem(`select settings from workspaces where id = $1`, [wsId]);
  const didNumbers = wsCheck.settings?.did_numbers || [];
  reporter.assert(
    Array.isArray(didNumbers) && didNumbers.includes('+918049368621'),
    'Hinduja helpline DID (+918049368621) registered in workspace settings',
    didNumbers
  );
  reporter.endStep();

  // ============================================================================
  // STEP 2: Confirm Scheduler, Webhook Delivery & Ingress Readiness
  // (docs/CALLBACKS.md #2)
  // ============================================================================
  reporter.startStep(
    2,
    'Confirm minute scheduler, webhook deliveries and storage ingress',
    'Validates webhook_events storage, idempotent unique constraints, and autodial_claim readiness.'
  );

  const [whTable] = await asSystem(`select to_regclass('webhook_events')::text as t`);
  reporter.assert(whTable.t === 'webhook_events', 'webhook_events table exists with append-only log');

  // Verify scheduler claim procedure exists and system role access
  const [claimCheck] = await asSystem(`select autodial_claim() as claims`);
  reporter.assert(Array.isArray(claimCheck.claims), 'autodial_claim() executes successfully under service role', claimCheck);

  // Negative security check: agent cannot trigger autodial_claim directly
  let agentClaimBlocked = false;
  try {
    await asUser('agent', `select autodial_claim()`);
  } catch (err) {
    agentClaimBlocked = /System only/i.test(err.message);
  }
  reporter.assert(agentClaimBlocked, 'Agent role is blocked from executing system autodial_claim()');
  reporter.endStep();

  // ============================================================================
  // STEP 3: Test Agent Availability & MyOperator Account Link
  // (docs/CALLBACKS.md #3)
  // ============================================================================
  reporter.startStep(
    3,
    'Mark test agent Available in CRM and verify MyOperator linkage',
    'Ensures test agent A-07 is active, linked to vendor user ID mo-a07, and marked Available.'
  );

  // Set agent available
  await asUser('agent', `select set_my_availability(true)`);
  const [agentProfile] = await asSystem(
    `select id, full_name, role, available, myoperator_user_id from profiles where id = $1`,
    [users.agent]
  );
  reporter.assert(agentProfile.available === true, 'Test agent marked Available in CRM', agentProfile);
  reporter.assert(agentProfile.myoperator_user_id === 'mo-a07', 'Test agent linked to MyOperator user ID mo-a07');
  reporter.assert(agentProfile.role === 'agent', 'Test agent has valid operational role');

  const [activeCalls] = await asSystem(
    `select count(*)::int as n from calls where agent_id = $1 and status in ('ringing','answered')`,
    [users.agent]
  );
  reporter.assert(activeCalls.n === 0, 'Test agent has 0 active ringing/answered calls (ready for selection)');
  reporter.endStep();

  // ============================================================================
  // STEP 4: Simulate Controlled Missed Inbound Call (and Abandoned Call)
  // (docs/CALLBACKS.md #4 & Prompt Step 1)
  // ============================================================================
  reporter.startStep(
    4,
    'Simulate missed inbound call and abandoned call via mock MyOperator webhooks',
    'Delivers inbound call events resulting in missed status with ring duration, followed by abandoned call.'
  );

  const testCaller = '+919811199991';
  const callStart = new Date(Date.now() - 5 * 60000); // 5 minutes ago
  const callEnd = new Date(callStart.getTime() + 25000); // 25s ring

  // 1. Inbound ringing
  const whInit = await dispatchMockWebhook({
    event_id: 'wh-miss-init-01',
    event_type: 'call.initiated',
    direction: 'inbound',
    session_id: 'sess-miss-test-01',
    customer_identifier: testCaller,
    system_identifier: '+918049368621',
    timestamp: Math.floor(callStart.getTime() / 1000),
    payload: { started_at: callStart.toISOString() },
  });
  reporter.assert(whInit.stored && whInit.applied, 'Missed call.initiated webhook processed and stored');

  // 2. Inbound missed end
  const whEnd = await dispatchMockWebhook({
    event_id: 'wh-miss-end-01',
    event_type: 'call.end',
    direction: 'inbound',
    session_id: 'sess-miss-test-01',
    customer_identifier: testCaller,
    system_identifier: '+918049368621',
    timestamp: Math.floor(callEnd.getTime() / 1000),
    payload: {
      status: 'missed',
      ended_at: callEnd.toISOString(),
      legs: [{ ring_duration: 25 }],
    },
  });
  reporter.assert(whEnd.stored && whEnd.applied, 'Missed call.end webhook processed and stored');

  // Verify calls row
  const [missedCallRow] = await asSystem(
    `select id, direction, status, customer_number, ring_seconds, ended_at from calls where session_id = 'sess-miss-test-01'`
  );
  reporter.assert(missedCallRow.status === 'missed', 'Call recorded with status missed', missedCallRow);
  reporter.assert(missedCallRow.customer_number === testCaller, 'Call customer_number matches normalized caller');
  reporter.assert(missedCallRow.ring_seconds === 25, 'Call ring_seconds recorded accurately (25s)');

  // 3. Repeat with abandoned call
  const abandCaller = '+919811199992';
  await dispatchMockWebhook({
    event_id: 'wh-aband-end-01',
    event_type: 'call.end',
    direction: 'inbound',
    session_id: 'sess-aband-test-01',
    customer_identifier: abandCaller,
    system_identifier: '+918049368621',
    timestamp: Math.floor(callEnd.getTime() / 1000),
    payload: {
      status: 'hangup_in_ivr',
      category: 'abandoned',
      ended_at: callEnd.toISOString(),
      legs: [{ ring_duration: 12 }],
    },
  });
  const [abandCallRow] = await asSystem(
    `select status, ring_seconds from calls where session_id = 'sess-aband-test-01'`
  );
  reporter.assert(abandCallRow.status === 'abandoned', 'Abandoned inbound call categorized as abandoned', abandCallRow);
  reporter.endStep();

  // ============================================================================
  // STEP 5: Verify Webhook Deduplication & Exactly One Callback Created
  // (docs/CALLBACKS.md #5)
  // ============================================================================
  reporter.startStep(
    5,
    'Verify exactly one callback per eligible original call and repeated webhook deduplication',
    'Replays exact same webhook event and ensures duplicate is ignored without creating duplicate callbacks.'
  );

  // Replay identical webhook event
  const whReplay = await dispatchMockWebhook({
    event_id: 'wh-miss-end-01', // duplicate ID
    event_type: 'call.end',
    direction: 'inbound',
    session_id: 'sess-miss-test-01',
    customer_identifier: testCaller,
  });
  reporter.assert(whReplay.stored === false && whReplay.reason === 'duplicate_event', 'Duplicate webhook event skipped via idempotency check');

  // Query callback queue for this number
  const callbacks = await asSystem(
    `select id, number, call_id, reason, status from callbacks where number = $1`,
    [testCaller]
  );
  reporter.assert(callbacks.length === 1, `Exactly ONE callback created for ${testCaller} (found: ${callbacks.length})`, callbacks);
  reporter.assert(callbacks[0].reason === 'missed', 'Callback reason correctly set to missed');
  reporter.assert(callbacks[0].call_id === missedCallRow.id, 'Callback linked to origin missed call ID');
  reporter.endStep();

  // ============================================================================
  // STEP 6: Verify Queue Creation with Initial Delay & SLA Scheduling
  // (docs/CALLBACKS.md #6 & Prompt Step 2)
  // ============================================================================
  reporter.startStep(
    6,
    'Verify queue creation with initial delay, eligible_at calculation, and deadline',
    'Validates eligible_at = origin call ended_at + 30m initial delay, due_at deadline, and SLA timer.'
  );

  const testCallbackId = callbacks[0].id;
  const [cbDetails] = await asSystem(
    `select id, status, origin_call_at, eligible_at, due_at, next_attempt_at, attempts
     from callbacks where id = $1`,
    [testCallbackId]
  );

  reporter.assert(cbDetails.status === 'pending', 'Callback status is pending in queue', cbDetails);
  reporter.assert(cbDetails.attempts === 0, 'Initial attempts count is 0');

  // Verify origin_call_at matches call end
  const originTime = new Date(cbDetails.origin_call_at).getTime();
  const expectedOriginTime = new Date(missedCallRow.ended_at).getTime();
  reporter.assert(
    Math.abs(originTime - expectedOriginTime) < 1000,
    'origin_call_at anchored to original call ended_at',
    { origin_call_at: cbDetails.origin_call_at, ended_at: missedCallRow.ended_at }
  );

  // Verify eligible_at is origin + 30 min initial delay
  const eligibleTime = new Date(cbDetails.eligible_at).getTime();
  const diffMinutes = Math.round((eligibleTime - originTime) / 60000);
  reporter.assert(diffMinutes === 30, `eligible_at is exactly 30 minutes after original call end (diff: ${diffMinutes}m)`);

  // Verify due_at = eligible_at + 30 min buffer window
  const dueTime = new Date(cbDetails.due_at).getTime();
  const windowMinutes = Math.round((dueTime - eligibleTime) / 60000);
  reporter.assert(windowMinutes === 30, `due_at deadline is anchored to eligible_at + 30m window (window: ${windowMinutes}m)`);

  // Verify SLA timer started
  const [slaTimer] = await asSystem(
    `select id, policy_key, status, due_at, met_at from sla_timers
     where callback_id = $1 and policy_key = 'missed_callback'`,
    [testCallbackId]
  );
  reporter.assert(slaTimer != null && slaTimer.status === 'running', 'missed_callback SLA timer running', slaTimer);

  // Test delay enforcement: when eligible_at > now(), autodial_claim must NOT dial
  const prematureFuture = new Date(Date.now() + 20 * 60000).toISOString();
  await asSystem(`update callbacks set eligible_at = $1::timestamptz, next_attempt_at = $1::timestamptz where id = $2`, [
    prematureFuture,
    testCallbackId,
  ]);
  const [prematureClaim] = await asSystem(`select autodial_claim() as claims`);
  const prematureMatch = (prematureClaim.claims || []).find((c) => c.callback_id === testCallbackId);
  reporter.assert(!prematureMatch, 'Callback is NOT dialled before eligible_at has arrived (initial delay respected)');

  // Now fast-forward callback eligibility to now (simulating 30m elapsed)
  await asSystem(
    `update callbacks set
       eligible_at = now() - interval '1 minute',
       next_attempt_at = now() - interval '1 minute',
       due_at = now() + interval '29 minutes'
     where id = $1`,
    [testCallbackId]
  );
  reporter.endStep();

  // ============================================================================
  // STEP 7: Trigger Cron Sweep & Free Agent Selection
  // (docs/CALLBACKS.md #6 & Prompt Step 3)
  // ============================================================================
  reporter.startStep(
    7,
    'Trigger cron sweep (autodial_claim) and select free available agent',
    'Runs the scheduler sweep: pairs eligible callback with free Available agent mo-a07 and creates outbound call.'
  );

  const [claimRun] = await asSystem(`select autodial_claim() as claims`);
  const claims = claimRun.claims || [];
  const activeClaim = claims.find((c) => c.callback_id === testCallbackId);

  reporter.assert(activeClaim != null, 'Auto-dialer claimed eligible callback', activeClaim);
  reporter.assert(activeClaim.agent_id === users.agent, 'Claimed agent matches free Available test agent (A-07)');
  reporter.assert(activeClaim.myoperator_user_id === 'mo-a07', 'Claimed MyOperator user ID matches mo-a07');
  reporter.assert(activeClaim.number === testCaller, 'Outbound target matches customer number');

  // Verify callback in_progress transition
  const [claimedCb] = await asSystem(`select status, attempts, assigned_to, auto_dialled from callbacks where id = $1`, [
    testCallbackId,
  ]);
  reporter.assert(claimedCb.status === 'in_progress', 'Callback transitioned to in_progress status', claimedCb);
  reporter.assert(claimedCb.attempts === 1, 'Callback attempts count incremented to 1');
  reporter.assert(claimedCb.assigned_to === users.agent, 'Callback assigned_to set to test agent');
  reporter.assert(claimedCb.auto_dialled === true, 'Callback marked auto_dialled = true');

  // Verify outbound call created in ringing state
  const outboundCallId = activeClaim.call_id;
  const outboundRef = activeClaim.ref;
  const [outboundCall] = await asSystem(
    `select id, direction, status, callback_id, agent_id, click_to_call_ref from calls where id = $1`,
    [outboundCallId]
  );
  reporter.assert(outboundCall.direction === 'outbound', 'Outbound call record created', outboundCall);
  reporter.assert(outboundCall.status === 'ringing', 'Outbound call starts in ringing state');
  reporter.assert(outboundCall.callback_id === testCallbackId, 'Outbound call links back to callback ID');
  reporter.assert(outboundCall.click_to_call_ref === outboundRef, 'Outbound call has correlation click_to_call_ref');
  reporter.endStep();

  // ============================================================================
  // STEP 8: Simulate Agent-First Answer (Verify it does NOT mark Reached)
  // (docs/CALLBACKS.md #7 & Prompt Step 4)
  // ============================================================================
  reporter.startStep(
    8,
    'Simulate agent-first answer and verify callback is NOT marked Reached',
    'Agent phone answers first in bridged campaign; verifies callback remains in_progress until customer connects.'
  );

  const tAgentAnswer = Math.floor(Date.now() / 1000);
  const agentAnswerWebhook = await dispatchMockWebhook({
    event_id: 'wh-out-agent-ans-01',
    event_type: 'call.answered',
    direction: 'outbound',
    session_id: 'sess-out-dial-01',
    client_ref_id: outboundRef,
    customer_identifier: testCaller,
    timestamp: tAgentAnswer,
    payload: {
      client_ref_id: outboundRef,
      legs: [
        {
          type: 'agent',
          dial_status: 'ANSWER',
          answered_at: tAgentAnswer,
          agent: { uuid: 'mo-a07' },
        },
      ],
    },
  });
  reporter.assert(agentAnswerWebhook.stored && agentAnswerWebhook.applied, 'Agent-first answer webhook processed');

  // Verify outbound call status
  const [callAfterAgentAns] = await asSystem(`select status from calls where id = $1`, [outboundCallId]);
  reporter.assert(callAfterAgentAns.status === 'answered', 'Call row status updated to answered upon agent pickup');

  // CRITICAL Telephony Assertion: Callback MUST NOT transition to 'reached' yet!
  const [cbAfterAgentAns] = await asSystem(
    `select status, reached_at, reached_call_id, completed_at from callbacks where id = $1`,
    [testCallbackId]
  );
  reporter.assert(cbAfterAgentAns.status === 'in_progress', 'CRITICAL: Callback remains in_progress (NOT Reached)', cbAfterAgentAns);
  reporter.assert(cbAfterAgentAns.reached_at === null, 'CRITICAL: reached_at is still NULL');
  reporter.assert(cbAfterAgentAns.reached_call_id === null, 'CRITICAL: reached_call_id is still NULL');

  // Verify SLA timer still running (not met)
  const [slaAfterAgentAns] = await asSystem(
    `select status, met_at from sla_timers where callback_id = $1 and policy_key = 'missed_callback'`,
    [testCallbackId]
  );
  reporter.assert(slaAfterAgentAns.status === 'running' && slaAfterAgentAns.met_at === null, 'SLA timer remains running (customer not yet connected)');
  reporter.endStep();

  // ============================================================================
  // STEP 9: Simulate Customer Leg Answer (Verify Transition to Reached & SLA Met)
  // (docs/CALLBACKS.md #8 & Prompt Step 5)
  // ============================================================================
  reporter.startStep(
    9,
    'Simulate customer leg answer and verify transition to Reached',
    'Customer picks up the bridged leg; callback moves to Reached, SLA met, and pending count drops.'
  );

  // Check pending KPI before customer connect
  const [kpiBefore] = await asUser(
    'sup',
    `select (dashboard_kpis(now() - interval '1 day', now() + interval '1 day')->>'callbacks_pending')::int as n`
  );

  const tCustAnswer = tAgentAnswer + 5; // 5s later
  const customerAnswerWebhook = await dispatchMockWebhook({
    event_id: 'wh-out-cust-ans-01',
    event_type: 'call.answered',
    direction: 'outbound',
    session_id: 'sess-out-dial-01',
    client_ref_id: outboundRef,
    customer_identifier: testCaller,
    timestamp: tCustAnswer,
    payload: {
      client_ref_id: outboundRef,
      legs: [
        {
          type: 'agent',
          dial_status: 'ANSWER',
          answered_at: tAgentAnswer,
        },
        {
          type: 'customer',
          phone_number: testCaller,
          dial_status: 'ANSWER',
          answered_at: tCustAnswer,
          ring_duration: 5,
        },
      ],
    },
  });
  reporter.assert(customerAnswerWebhook.stored && customerAnswerWebhook.applied, 'Customer leg answer webhook processed');

  // Verify callback transitioned to 'reached'
  const [cbAfterCustAns] = await asSystem(
    `select status, reached_at, reached_call_id, completed_at, assigned_to from callbacks where id = $1`,
    [testCallbackId]
  );
  reporter.assert(cbAfterCustAns.status === 'reached', 'Callback transitioned to reached status', cbAfterCustAns);
  reporter.assert(cbAfterCustAns.reached_at != null, 'reached_at timestamp populated');
  reporter.assert(cbAfterCustAns.reached_call_id === outboundCallId, 'reached_call_id points to outbound call ID');
  reporter.assert(cbAfterCustAns.completed_at === null, 'completed_at remains null (awaiting closing outcome)');

  // Verify SLA timer marked MET
  const [slaAfterCustAns] = await asSystem(
    `select status, met_at from sla_timers where callback_id = $1 and policy_key = 'missed_callback'`,
    [testCallbackId]
  );
  reporter.assert(slaAfterCustAns.status === 'met' && slaAfterCustAns.met_at != null, 'missed_callback SLA timer marked MET upon customer connection');

  // Verify pending KPI dropped
  const [kpiAfter] = await asUser(
    'sup',
    `select (dashboard_kpis(now() - interval '1 day', now() + interval '1 day')->>'callbacks_pending')::int as n`
  );
  reporter.assert(
    kpiAfter.n === kpiBefore.n - 1,
    `Dashboard pending callbacks KPI decremented (${kpiBefore.n} -> ${kpiAfter.n})`
  );
  reporter.endStep();

  // ============================================================================
  // STEP 10: Call Completion, Close with Outcome 'Resolved', Edge Cases & Teardown
  // (docs/CALLBACKS.md #8, #9, #10 & Prompt Step 6)
  // ============================================================================
  reporter.startStep(
    10,
    'Complete conversation (>=20s), close callback with outcome Resolved, test capacity edge cases & teardown',
    'Concludes talk time > 20s, records resolved outcome via callback_close, validates capacity isolation and restores settings.'
  );

  // 1. Simulate call completion (> 20s conversation)
  const tCallEnd = tCustAnswer + 95; // 95 seconds talk
  await dispatchMockWebhook({
    event_id: 'wh-out-end-01',
    event_type: 'call.end',
    direction: 'outbound',
    session_id: 'sess-out-dial-01',
    client_ref_id: outboundRef,
    customer_identifier: testCaller,
    timestamp: tCallEnd,
    payload: {
      status: 'completed',
      client_ref_id: outboundRef,
      ended_at: new Date(tCallEnd * 1000).toISOString(),
      legs: [
        { type: 'agent', talk_duration: 100 },
        { type: 'customer', phone_number: testCaller, talk_duration: 95 },
      ],
    },
  });

  const [callEndedState] = await asSystem(`select status, talk_seconds from calls where id = $1`, [outboundCallId]);
  reporter.assert(callEndedState.status === 'completed', 'Outbound call status completed');
  reporter.assert(callEndedState.talk_seconds === 95, 'Outbound call customer talk_seconds recorded as 95s');

  const [cbPostCall] = await asSystem(`select status from callbacks where id = $1`, [testCallbackId]);
  reporter.assert(cbPostCall.status === 'reached', 'Callback stays in reached state after 95s call (waiting for outcome)');

  // 2. Validate agent outcome validation rules
  let blankOutcomeBlocked = false;
  try {
    await asUser('agent', `select callback_close($1::uuid, 'done')`, [testCallbackId]);
  } catch (err) {
    blankOutcomeBlocked = /Choose an outcome/i.test(err.message);
  }
  reporter.assert(blankOutcomeBlocked, 'callback_close rejects invalid outcome without specific choice');

  let emptyFollowUpBlocked = false;
  try {
    await asUser('agent', `select callback_close($1::uuid, 'follow_up', '   ')`, [testCallbackId]);
  } catch (err) {
    emptyFollowUpBlocked = /follow-up/i.test(err.message);
  }
  reporter.assert(emptyFollowUpBlocked, 'callback_close rejects follow_up outcome without notes');

  // 3. Agent closes callback with 'resolved' outcome
  const [closeResult] = await asUser(
    'agent',
    `select callback_close($1::uuid, 'resolved', 'Home nurse visit confirmed for 10am tomorrow') as r`,
    [testCallbackId]
  );
  reporter.assert(closeResult.r.status === 'done', 'Callback closed with status done', closeResult.r);
  reporter.assert(closeResult.r.outcome === 'resolved', 'Callback outcome recorded as resolved');

  const [cbFinal] = await asSystem(
    `select status, outcome, outcome_note, completed_by, completed_at from callbacks where id = $1`,
    [testCallbackId]
  );
  reporter.assert(cbFinal.status === 'done', 'Final callback status in DB is done');
  reporter.assert(cbFinal.outcome === 'resolved', 'Final outcome is resolved');
  reporter.assert(cbFinal.outcome_note === 'Home nurse visit confirmed for 10am tomorrow', 'Outcome note persisted');
  reporter.assert(cbFinal.completed_by === users.agent, 'completed_by matches agent user ID');
  reporter.assert(cbFinal.completed_at != null, 'completed_at timestamp recorded');

  // Verify double-closing is blocked
  let doubleCloseBlocked = false;
  try {
    await asUser('agent', `select callback_close($1::uuid, 'resolved')`, [testCallbackId]);
  } catch (err) {
    doubleCloseBlocked = /already closed/i.test(err.message);
  }
  reporter.assert(doubleCloseBlocked, 'Double-closing an already resolved callback is blocked');

  // 4. Test edge case: Short call drop-off (< 20s) returns to retry and reopens SLA
  const [shortCb] = await asSystem(
    `insert into callbacks (workspace_id, number, reason, due_at, status, attempts)
     values ($1, '+919811199993', 'missed', now() + interval '25 minutes', 'in_progress', 1)
     returning id`,
    [wsId]
  );
  const [shortCall] = await asSystem(
    `insert into calls (workspace_id, direction, customer_number, status, callback_id, talk_seconds)
     values ($1, 'outbound', '+919811199993', 'completed', $2, 6) returning id`,
    [wsId, shortCb.id]
  );
  // Reached then dropped
  await asSystem(`select callback_connected($1::uuid)`, [shortCall.id]);
  const [shortEndResult] = await asSystem(`select callback_call_ended($1::uuid) as r`, [shortCall.id]);
  const [shortCbState] = await asSystem(`select status, notes from callbacks where id = $1`, [shortCb.id]);
  reporter.assert(shortEndResult.r === 'pending', 'Short call (6s) returns callback to pending for retry');
  reporter.assert(shortCbState.status === 'pending', 'Callback status reverted to pending after < 20s drop-off');

  // 5. Test edge case: Capacity exhaustion / deadline expiry without eligible agent
  // (Verifies migration 20261019150000_callback_agent_unavailable.sql behavior)
  const [expiredCb] = await asSystem(
    `insert into callbacks (workspace_id, number, reason, due_at, eligible_at, next_attempt_at, status, attempts)
     values ($1, '+919811199994', 'missed', now() - interval '1 minute', now() - interval '31 minutes', now() - interval '1 minute', 'pending', 0)
     returning id`,
    [wsId]
  );
  // Run claim sweep when capacity expired and attempts = 0
  await asSystem(`select autodial_claim()`);
  const [expiredCbState] = await asSystem(`select status, notes from callbacks where id = $1`, [expiredCb.id]);
  reporter.assert(
    expiredCbState.status === 'agent_unavailable',
    'Expired callback with 0 attempts transitions to agent_unavailable (capacity exhaustion)',
    expiredCbState
  );

  // 6. Restore temporary settings & agent availability
  await asUser('agent', `select set_my_availability(false)`);
  const [restoredAgent] = await asSystem(`select available from profiles where id = $1`, [users.agent]);
  reporter.assert(restoredAgent.available === false, 'Test agent availability reset to false (cleanup)');

  reporter.endStep();

  // Print Formatted Execution Report
  const finalReport = reporter.generateReport();
  return finalReport;
}

// --- Run and Exit ---
runTelephonySimulation()
  .then((report) => {
    if (!report.isSuccess) {
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n\x1b[31mFatal Simulation Error:\x1b[0m', err);
    process.exit(1);
  });
