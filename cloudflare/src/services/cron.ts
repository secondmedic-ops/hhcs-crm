// Scheduled jobs (wrangler.jsonc triggers)
//   * * * * *    SLA scan: breaches -> auto escalation + notifications, at-risk flags, escalation level-ups; scheduled selling prices;
//                MyOperator call-log sync (calls, missed-call callbacks, recordings without webhooks); one AI call summary
//   30 4 * * *   10:00 IST: daily MIS for yesterday; Mondays also weekly; 1st of the month also monthly
import { asSystem, connect, type Sql } from '../db';
import type { Env } from '../env';
import { misNarrative, summariseBacklog } from './ai';
import { aiEnv } from './ai-config';
import { notifyLive } from './live';
import { syncCallLogs } from './mo-sync';
import { runAutodial } from './autodial';
import { safeSmtpError, sendMail, smtpReady, SmtpError } from './smtp';

const istDate = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

export async function runScheduled(cron: string, env: Env, exec: ExecutionContext) {
  const sql = connect(env);
  try {
    if (cron === '* * * * *') {
      // call-log sync first, so a missed call it brings in gets its callback timer in this same minute
      try { const r = await syncCallLogs(env, sql, exec); if (r.ok === false) console.log('myoperator sync', r.error); }
      catch (e) { console.log('myoperator sync', (e as Error).message); }
      const { changed } = await asSystem(sql, (tx) => tx`select sla_scan()`);
      // approved selling prices whose effective date has come (Settings > Rate card > Import rates)
      try { const r = await asSystem(sql, (tx) => tx`select activate_due_prices()`); changed.push(...r.changed); }
      catch (e) { console.log('price activation', (e as Error).message); }
      // callback auto-dialer after the sync, so a missed call it just brought in can be dialled this minute
      try {
        const r = await runAutodial(env, sql);
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
        await emailMis(env, sql, s.id, s.workspace_id, period, from, to, s.data, narrative);
      }
    }
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

const esc = (v: unknown) => String(v ?? '–').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * MIS by e-mail through Gmail SMTP, at most once per snapshot: the row is claimed first (a repeated or overlapping cron
 * run finds it claimed or sent and skips it). Only an accepted send sets emailed_at; a failure keeps the reason; an
 * unknown outcome (connection lost after the message was handed over) is never re-sent automatically.
 */
export async function emailMis(env: Env, sql: Sql, id: string, workspaceId: string, period: string, from: string, to: string, d: any, narrative: string | null,
  send: typeof sendMail = sendMail) {
  const recipients = (env.MIS_RECIPIENTS || '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!recipients.length || !smtpReady(env)) return { skipped: true };
  const claimed = await sql`update mis_snapshots set email_status = 'sending', email_attempted_at = now()
    where id = ${id} and emailed_at is null and coalesce(email_status, '') not in ('accepted', 'unknown')
      and (email_status is distinct from 'sending' or email_attempted_at < now() - interval '15 minutes')
    returning id`;
  if (!claimed.length) return { skipped: true };
  const row = (k: string, v: unknown) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${k}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`;
  const lines: [string, unknown][] = [['Calls', d.calls?.total], ['Answered within 30 s', (d.calls?.answer_within_30s_pct ?? '–') + '%'],
    ['Missed / abandoned', (d.calls?.missed || 0) + ' / ' + (d.calls?.abandoned || 0)],
    ['Enquiries to bookings', `${d.funnel?.enquiries} to ${d.funnel?.bookings} (${d.funnel?.conversion_pct ?? 0}%)`], ['Completed value', '₹' + (d.revenue?.completed_value || 0)],
    ['Collections', '₹' + (d.collections?.collected || 0)], ['Outstanding', '₹' + (d.outstanding || 0)], ['New complaints', d.complaints?.new],
    ['Cancellations', (d.cancellations || []).reduce((s: number, x: any) => s + x.n, 0)]];
  const title = `${period[0].toUpperCase() + period.slice(1)} MIS · ${from}${from !== to ? ' to ' + to : ''}`;
  const link = `${env.APP_URL || ''}/mis`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b1d1c">
  <p>${esc(title)}</p>
  ${narrative ? `<p>${esc(narrative)}</p>` : ''}
  <table>${lines.map(([k, v]) => row(k, v)).join('')}</table>
  <p>Full pack with Excel / PDF export is on the dashboard: ${esc(link)}</p></div>`;
  const text = [title, '', ...(narrative ? [narrative, ''] : []), ...lines.map(([k, v]) => `${k}: ${v ?? '–'}`), '', `Full pack with Excel / PDF export: ${link}`].join('\n');
  let status = 'accepted', error: string | null = null;
  try {
    await send(env, { to: recipients, subject: `HHCS ${period} MIS · ${to}`, text, html });
  } catch (e) {
    status = e instanceof SmtpError && e.ambiguous ? 'unknown' : 'failed';
    error = safeSmtpError(e);
    console.log('mis email', period, status, error);
  }
  await sql`update mis_snapshots set email_status = ${status}, email_error = ${error},
    emailed_at = case when ${status} = 'accepted' then now() end where id = ${id}`;
  await sql`insert into access_log (workspace_id, action, entity, entity_id, meta)
    values (${workspaceId}, 'mis_email', 'mis_snapshot', ${id}, ${sql.json({ period, status, recipients: recipients.length, error })})`.catch(() => {});
  return { status, error };
}
