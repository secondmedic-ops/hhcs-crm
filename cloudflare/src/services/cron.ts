// Scheduled jobs (wrangler.jsonc triggers)
//   * * * * *    SLA scan: breaches -> auto escalation + notifications, at-risk flags, escalation level-ups; scheduled selling prices;
//                MyOperator call-log sync (calls, missed-call callbacks, recordings without webhooks); one AI call summary
//   30 2 * * *   08:00 IST: daily MIS for yesterday; Mondays also weekly; 1st of the month also monthly
import { asSystem, connect, type Sql } from '../db';
import type { Env } from '../env';
import { misNarrative, summariseBacklog } from './ai';
import { aiEnv } from './ai-config';
import { notifyLive } from './live';
import { syncCallLogs } from './mo-sync';
import { runAutodial, type Claim } from './autodial';
import { missingCallingSettings, moEnv } from './myoperator-config';
import { safeSmtpError, sendMail, smtpReady, SmtpError } from './smtp';

const istDate = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

export async function runScheduled(cron: string, env: Env, exec: ExecutionContext) {
  const sql = connect(env);
  try {
    if (cron === '* * * * *') {
      // MyOperator settings once for the sync and the auto-dialer (one query instead of two)
      const mo = await moEnv(env, sql);
      // call-log sync first, so a missed call it brings in gets its callback timer in this same minute
      try { const r = await syncCallLogs(env, sql, exec, { mo }); if (r.ok === false) console.log('myoperator sync', r.error); }
      catch (e) { console.log('myoperator sync', (e as Error).message); }
      // one transaction (migration cron_minute): missed-call sweep (callback for a missed / abandoned call of the last
      // 24 h), webhook silence (working hours, no MyOperator event for N hours), SLA scan, due selling prices
      // (Settings > Rate card > Import rates), auto-dialer claim. A failing step is reported in errors; the others run.
      const changed: string[] = [];
      let claims: Claim[] = [];
      try {
        const r = await asSystem(sql, (tx) => tx`select cron_minute(${missingCallingSettings(mo).length === 0}) as r`);
        const out = (r.result[0]?.r || {}) as { swept?: number; silence?: number; claims?: Claim[]; errors?: Record<string, string> };
        changed.push(...r.changed);
        claims = out.claims || [];
        if (out.swept) console.log('missed-call sweep', out.swept);
        if (out.silence) console.log('webhook silence alert', out.silence);
        for (const [step, msg] of Object.entries(out.errors || {})) console.log('cron ' + step, msg);
      } catch (e) { console.log('cron minute', (e as Error).message); }
      // callback auto-dialer after the sync, so a missed call it just brought in can be dialled this minute
      try {
        const r = await runAutodial(env, sql, { mo, claims });
        changed.push(...r.changed);
        if (r.dialled || r.failed) console.log('autodial', JSON.stringify({ dialled: r.dialled, failed: r.failed }));
      } catch (e) { console.log('autodial', (e as Error).message); }
      notifyLive(env, exec, [...new Set(changed)]);
      // last, so it never delays the SLA scan: one recorded call without an AI summary (webhook missed it, synced call, retry)
      try { const r = await summariseBacklog(env, sql, exec); if (r.failed) console.log('ai backlog', r.error); }
      catch (e) { console.log('ai backlog', (e as Error).message); }
      return;
    }
    const today = new Date(Date.now() + 5.5 * 3600e3);
    const jobs: [string, string, string][] = [['daily', istDate(-1), istDate(-1)]];
    if (today.getUTCDay() === 1) jobs.push(['weekly', istDate(-7), istDate(-1)]);
    if (today.getUTCDate() === 1) { const end = istDate(-1); jobs.push(['monthly', end.slice(0, 8) + '01', end]); }
    for (const [period, from, to] of jobs) {
      const { result: snaps } = await asSystem(sql, async (tx) => {
        await tx`select generate_mis(${period}, ${from}::date, ${to}::date)`;
        return tx`select id, workspace_id, data from mis_snapshots where period = ${period} and period_start = ${from}::date`;
      });
      for (const s of snaps) {
        let narrative: string | null = null;
        const ai = await aiEnv(env, sql);
        if (ai.GEMINI_API_KEY) {
          try {
            narrative = await misNarrative(ai, period, s.data);
            await sql`update mis_snapshots set narrative = ${narrative} where id = ${s.id}`;
          } catch (e) { console.log('mis narrative', (e as Error).message); }
        }
        try {
          await emailMis(env, sql, s.id, s.workspace_id, period, from, to, s.data, narrative);
        } catch (e) {
          console.error('mis email unexpected failure', period, s.id, (e as Error).message);
        }
      }
    }
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

const esc = (v: unknown) => String(v ?? '–').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface MisEmailContent {
  subject: string;
  html: string;
  text: string;
}

/** Formats daily MIS metrics into a clean HTML table and text template. */
export function formatMisEmail(
  period: string,
  from: string,
  to: string,
  d: any,
  narrative: string | null,
  activeSlaBreaches: number,
  appUrl: string
): MisEmailContent {
  const periodTitle = period[0].toUpperCase() + period.slice(1);
  const title = `${periodTitle} MIS · ${from}${from !== to ? ' to ' + to : ''}`;
  const subject = `HHCS ${period} MIS · ${to}`;
  const link = `${appUrl || ''}/mis`;

  // 1. Daily Case Volume & Funnel
  const enquiries = Number(d.funnel?.enquiries) || 0;
  const quotes = Number(d.funnel?.quotes) || 0;
  const bookings = Number(d.funnel?.bookings) || 0;
  const completions = Number(d.funnel?.completions) || 0;
  const cancellations = (d.cancellations || []).reduce((s: number, x: any) => s + (Number(x.n) || 0), 0);

  // 2. Conversion Rates
  const conversionPct = d.funnel?.conversion_pct != null
    ? `${d.funnel.conversion_pct}%`
    : `${enquiries > 0 ? ((bookings / enquiries) * 100).toFixed(1) : '0'}%`;
  const quoteConversionPct = quotes > 0 ? `${((bookings / quotes) * 100).toFixed(1)}%` : '–';
  const callAnswerPct = d.calls?.answer_within_30s_pct != null ? `${d.calls.answer_within_30s_pct}%` : '–';

  // 3. Active SLA Breaches
  const slaPolicies: any[] = Array.isArray(d.sla) ? d.sla : [];
  const periodBreaches = slaPolicies.reduce((s: number, x: any) => s + (Number(x.breached) || 0), 0);
  const breachedPolicies = slaPolicies.filter((x: any) => Number(x.breached) > 0);

  // 4. Collections Breakdown
  const totalCollected = Number(d.collections?.collected) || 0;
  const paymentCount = Number(d.collections?.count) || 0;
  const reconciledCount = Number(d.collections?.reconciled) || 0;
  const exceptionCount = Number(d.collections?.exceptions) || 0;
  const rawModes: Record<string, unknown> = (d.collections?.by_mode && typeof d.collections.by_mode === 'object') ? d.collections.by_mode : {};
  const modesList = Object.entries(rawModes)
    .map(([mode, amt]) => ({ mode: mode.replace(/_/g, ' ').toUpperCase(), amount: Number(amt) || 0 }))
    .filter((m) => m.amount > 0);
  const outstanding = Number(d.outstanding) || 0;
  const completedValue = Number(d.revenue?.completed_value) || 0;

  // 5. Calls & Operations
  const totalCalls = d.calls?.total != null ? d.calls.total : '–';
  const missedCalls = Number(d.calls?.missed) || 0;
  const abandonedCalls = Number(d.calls?.abandoned) || 0;
  const newComplaints = d.complaints?.new != null ? d.complaints.new : 0;

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;color:#1b1d1c;background:#f8fafc;padding:20px;line-height:1.5;">
  <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;padding:24px;">
    <div style="border-bottom:2px solid #0f172a;padding-bottom:12px;margin-bottom:16px;">
      <h2 style="margin:0;font-size:18px;font-weight:700;color:#0f172a;">${esc(title)}</h2>
      <div style="font-size:12px;color:#64748b;margin-top:4px;">CareDesk CRM · Generated ${esc(period)} report (${esc(from)}${from !== to ? ' to ' + esc(to) : ''})</div>
    </div>

    ${narrative ? `<div style="background:#f1f5f9;border-left:4px solid #334155;padding:12px;margin-bottom:20px;font-size:13px;color:#334155;line-height:1.5;">${esc(narrative)}</div>` : ''}

    <div style="margin-bottom:20px;">
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:10px;border:1px solid #e2e8f0;background:#f8fafc;width:25%;vertical-align:top;">
            <div style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;">Daily Enquiries</div>
            <div style="font-size:20px;font-weight:700;color:#0f172a;margin-top:2px;">${enquiries}</div>
            <div style="font-size:11px;color:#475569;margin-top:2px;">${bookings} booked</div>
          </td>
          <td style="padding:10px;border:1px solid #e2e8f0;background:#f8fafc;width:25%;vertical-align:top;">
            <div style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;">Conversion Rate</div>
            <div style="font-size:20px;font-weight:700;color:#0f172a;margin-top:2px;">${esc(conversionPct)}</div>
            <div style="font-size:11px;color:#475569;margin-top:2px;">Enquiries to bookings</div>
          </td>
          <td style="padding:10px;border:1px solid #e2e8f0;background:#f8fafc;width:25%;vertical-align:top;">
            <div style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;">Active Breaches</div>
            <div style="font-size:20px;font-weight:700;color:${activeSlaBreaches > 0 ? '#b91c1c' : '#15803d'};margin-top:2px;">${activeSlaBreaches}</div>
            <div style="font-size:11px;color:#475569;margin-top:2px;">${periodBreaches} in period</div>
          </td>
          <td style="padding:10px;border:1px solid #e2e8f0;background:#f8fafc;width:25%;vertical-align:top;">
            <div style="font-size:11px;font-weight:600;color:#64748b;text-transform:uppercase;">Collections</div>
            <div style="font-size:20px;font-weight:700;color:#0f172a;margin-top:2px;">₹${totalCollected.toLocaleString('en-IN')}</div>
            <div style="font-size:11px;color:#475569;margin-top:2px;">${paymentCount} payments</div>
          </td>
        </tr>
      </table>
    </div>

    <div style="margin-bottom:20px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#334155;margin-bottom:6px;border-bottom:1px solid #cbd5e1;padding-bottom:4px;">Case Volume & Funnel</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">New Enquiries</td><td style="padding:6px 0;text-align:right;font-weight:600;">${enquiries}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Quotes Sent</td><td style="padding:6px 0;text-align:right;font-weight:600;">${quotes}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Bookings Confirmed</td><td style="padding:6px 0;text-align:right;font-weight:600;">${bookings}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Services Completed</td><td style="padding:6px 0;text-align:right;font-weight:600;">${completions}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Cancellations</td><td style="padding:6px 0;text-align:right;font-weight:600;">${cancellations}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Conversion Rate (Enquiries to Bookings)</td><td style="padding:6px 0;text-align:right;font-weight:600;">${esc(conversionPct)}</td></tr>
        ${quotes > 0 ? `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Quote Conversion (Quotes to Bookings)</td><td style="padding:6px 0;text-align:right;font-weight:600;">${esc(quoteConversionPct)}</td></tr>` : ''}
      </table>
    </div>

    <div style="margin-bottom:20px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#334155;margin-bottom:6px;border-bottom:1px solid #cbd5e1;padding-bottom:4px;">SLA Compliance & Active Breaches</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Active (Open) SLA Breaches</td><td style="padding:6px 0;text-align:right;font-weight:700;color:${activeSlaBreaches > 0 ? '#b91c1c' : '#15803d'};">${activeSlaBreaches}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Period Breaches (Total in range)</td><td style="padding:6px 0;text-align:right;font-weight:600;">${periodBreaches}</td></tr>
        ${breachedPolicies.length > 0
          ? `<tr><td colspan="2" style="padding:6px 0 2px 0;color:#64748b;font-size:12px;">Policies with Breaches:</td></tr>` +
            breachedPolicies.map((p) => `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:4px 0 4px 12px;color:#64748b;">${esc(p.label)} (${esc(p.target_minutes)} min SLA)</td><td style="padding:4px 0;text-align:right;color:#b91c1c;font-weight:600;">${esc(p.breached)} breached (${esc(p.pct ?? 0)}% met)</td></tr>`).join('')
          : '<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Policy SLA Status</td><td style="padding:6px 0;text-align:right;color:#15803d;font-weight:600;">All policies within SLA target</td></tr>'}
      </table>
    </div>

    <div style="margin-bottom:20px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#334155;margin-bottom:6px;border-bottom:1px solid #cbd5e1;padding-bottom:4px;">Revenue & Collections Breakdown</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Total Collections</td><td style="padding:6px 0;text-align:right;font-weight:700;color:#0f172a;">₹${totalCollected.toLocaleString('en-IN')}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Payment Transactions</td><td style="padding:6px 0;text-align:right;font-weight:600;">${paymentCount} (${reconciledCount} reconciled, ${exceptionCount} exceptions)</td></tr>
        ${modesList.length > 0
          ? `<tr><td colspan="2" style="padding:6px 0 2px 0;color:#64748b;font-size:12px;">Collections Breakdown by Mode:</td></tr>` +
            modesList.map((m) => `<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:4px 0 4px 12px;color:#64748b;">${esc(m.mode)}</td><td style="padding:4px 0;text-align:right;font-weight:600;">₹${m.amount.toLocaleString('en-IN')}</td></tr>`).join('')
          : '<tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Collections Breakdown</td><td style="padding:6px 0;text-align:right;font-weight:600;">No collections recorded</td></tr>'}
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Completed Service Revenue</td><td style="padding:6px 0;text-align:right;font-weight:600;">₹${completedValue.toLocaleString('en-IN')}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Outstanding Receivables</td><td style="padding:6px 0;text-align:right;font-weight:600;color:${outstanding > 0 ? '#b91c1c' : '#0f172a'};">₹${outstanding.toLocaleString('en-IN')}</td></tr>
      </table>
    </div>

    <div style="margin-bottom:20px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#334155;margin-bottom:6px;border-bottom:1px solid #cbd5e1;padding-bottom:4px;">Call Center & Inquiries</div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Total Calls</td><td style="padding:6px 0;text-align:right;font-weight:600;">${esc(totalCalls)}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Answered within 30 s</td><td style="padding:6px 0;text-align:right;font-weight:600;">${esc(callAnswerPct)}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">Missed / Abandoned Calls</td><td style="padding:6px 0;text-align:right;font-weight:600;">${missedCalls} / ${abandonedCalls}</td></tr>
        <tr style="border-bottom:1px solid #e2e8f0;"><td style="padding:6px 0;color:#64748b;">New Complaints</td><td style="padding:6px 0;text-align:right;font-weight:600;">${newComplaints}</td></tr>
      </table>
    </div>

    <div style="border-top:1px solid #e2e8f0;padding-top:14px;font-size:12px;color:#64748b;">
      Full MIS pack with Excel / PDF export is available on the dashboard: <a href="${esc(link)}" style="color:#2563eb;text-decoration:none;">${esc(link)}</a>
    </div>
  </div>
</div>`;

  const modesText = modesList.length > 0
    ? modesList.map((m) => `  - ${m.mode}: ₹${m.amount.toLocaleString('en-IN')}`).join('\n')
    : '  - None recorded';

  const breachedPoliciesText = breachedPolicies.length > 0
    ? breachedPolicies.map((p) => `  - ${p.label}: ${p.breached} breached (${p.pct ?? 0}% met)`).join('\n')
    : '  - None (All within target)';

  const text = [
    title,
    '',
    ...(narrative ? [narrative, ''] : []),
    `Calls: ${totalCalls}`,
    `Answered within 30 s: ${callAnswerPct}`,
    `Missed / abandoned: ${missedCalls} / ${abandonedCalls}`,
    `Enquiries to bookings: ${enquiries} to ${bookings} (${conversionPct})`,
    `Completed value: ₹${completedValue}`,
    `Collections: ₹${totalCollected}`,
    `Outstanding: ₹${outstanding}`,
    `New complaints: ${newComplaints}`,
    `Cancellations: ${cancellations}`,
    '',
    '=== Case Volume & Funnel ===',
    `Enquiries: ${enquiries}`,
    `Quotes Sent: ${quotes}`,
    `Bookings Confirmed: ${bookings}`,
    `Services Completed: ${completions}`,
    `Cancellations: ${cancellations}`,
    `Conversion Rate: ${conversionPct}`,
    ...(quotes > 0 ? [`Quote Conversion: ${quoteConversionPct}`] : []),
    '',
    '=== SLA Compliance & Active Breaches ===',
    `Active (Open) SLA Breaches: ${activeSlaBreaches}`,
    `Period Breaches: ${periodBreaches}`,
    'Breached Policies:',
    breachedPoliciesText,
    '',
    '=== Collections Breakdown ===',
    `Total Collections: ₹${totalCollected.toLocaleString('en-IN')}`,
    `Transactions: ${paymentCount} (${reconciledCount} reconciled, ${exceptionCount} exceptions)`,
    'Collections by Mode:',
    modesText,
    `Completed Value: ₹${completedValue.toLocaleString('en-IN')}`,
    `Outstanding: ₹${outstanding.toLocaleString('en-IN')}`,
    '',
    `Full pack with Excel / PDF export: ${link}`,
  ].join('\n');

  return { subject, html, text };
}

/**
 * MIS by e-mail through Gmail SMTP, at most once per snapshot: the row is claimed first (a repeated or overlapping cron
 * run finds it claimed or sent and skips it). Only an accepted send sets emailed_at; a failure keeps the reason; an
 * unknown outcome (connection lost after the message was handed over) is never re-sent automatically.
 */
export async function emailMis(
  env: Env,
  sql: Sql,
  id: string,
  workspaceId: string,
  period: string,
  from: string,
  to: string,
  d: any,
  narrative: string | null,
  send: typeof sendMail = sendMail
) {
  const recipients = (env.MIS_RECIPIENTS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!recipients.length || !smtpReady(env)) return { skipped: true };
  const claimed = await sql`update mis_snapshots set email_status = 'sending', email_attempted_at = now()
    where id = ${id} and emailed_at is null and coalesce(email_status, '') not in ('accepted', 'unknown')
      and (email_status is distinct from 'sending' or email_attempted_at < now() - interval '15 minutes')
    returning id`;
  if (!claimed.length) return { skipped: true };

  // Determine active SLA breaches: query open breached timers for workspace, falling back to period snapshot
  let activeSlaBreaches = (Array.isArray(d.sla) ? d.sla : []).reduce((s: number, x: any) => s + (Number(x.breached) || 0), 0);
  try {
    const live = await sql`select count(*)::int as n from sla_timers where workspace_id = ${workspaceId} and status = 'breached' and met_at is null`;
    if (live && live[0] && live[0].n != null) {
      activeSlaBreaches = Number(live[0].n);
    }
  } catch {}

  const { subject, html, text } = formatMisEmail(period, from, to, d, narrative, activeSlaBreaches, env.APP_URL || '');

  let status = 'accepted', error: string | null = null;
  try {
    await send(env, { to: recipients, subject, text, html });
  } catch (e) {
    status = e instanceof SmtpError && e.ambiguous ? 'unknown' : 'failed';
    error = safeSmtpError(e);
    console.log('mis email', period, status, error);
  }

  await sql`update mis_snapshots set email_status = ${status}, email_error = ${error},
    emailed_at = case when ${status} = 'accepted' then now() end where id = ${id}`;

  if (status !== 'accepted') {
    await sql`insert into audit_log (workspace_id, table_name, record_id, action, changes)
      values (${workspaceId}, 'mis_snapshots', ${id}::uuid, 'smtp_error', ${sql.json({
        period,
        status,
        error,
        recipients: recipients.length,
        from,
        to,
      })})`.catch((err) => {
        console.error('Failed to write smtp_error to audit_log:', err);
      });
  }

  await sql`insert into access_log (workspace_id, action, entity, entity_id, meta)
    values (${workspaceId}, 'mis_email', 'mis_snapshot', ${id}, ${sql.json({ period, status, recipients: recipients.length, error })})`.catch(() => {});

  return { status, error };
}
