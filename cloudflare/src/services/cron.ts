// Scheduled jobs (wrangler.jsonc triggers)
//   * * * * *    SLA scan: breaches -> auto escalation + notifications, at-risk flags, escalation level-ups;
//                MyOperator call-log sync (calls, missed-call callbacks, recordings without webhooks)
//   30 4 * * *   10:00 IST: daily MIS for yesterday; Mondays also weekly; 1st of the month also monthly
import { asSystem, connect } from '../db';
import type { Env } from '../env';
import { misNarrative } from './ai';
import { notifyLive } from './live';
import { syncCallLogs } from './mo-sync';
import { runAutodial } from './autodial';

const istDate = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

export async function runScheduled(cron: string, env: Env, exec: ExecutionContext) {
  const sql = connect(env);
  try {
    if (cron === '* * * * *') {
      // call-log sync first, so a missed call it brings in gets its callback timer in this same minute
      try { const r = await syncCallLogs(env, sql, exec); if (r.ok === false) console.log('myoperator sync', r.error); }
      catch (e) { console.log('myoperator sync', (e as Error).message); }
      const { changed } = await asSystem(sql, (tx) => tx`select sla_scan()`);
      // callback auto-dialer after the sync, so a missed call it just brought in can be dialled this minute
      try {
        const r = await runAutodial(env, sql);
        changed.push(...r.changed);
        if (r.dialled || r.failed) console.log('autodial', JSON.stringify({ dialled: r.dialled, failed: r.failed }));
      } catch (e) { console.log('autodial', (e as Error).message); }
      notifyLive(env, exec, [...new Set(changed)]);
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
        if (env.GEMINI_API_KEY) {
          try {
            narrative = await misNarrative(env, period, s.data);
            await sql`update mis_snapshots set narrative = ${narrative} where id = ${s.id}`;
          } catch (e) { console.log('mis narrative', (e as Error).message); }
        }
        await emailMis(env, period, from, to, s.data, narrative);
      }
    }
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

const esc = (v: unknown) => String(v ?? '–').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

async function emailMis(env: Env, period: string, from: string, to: string, d: any, narrative: string | null) {
  if (!env.RESEND_API_KEY || !env.MIS_RECIPIENTS) return;
  const row = (k: string, v: unknown) => `<tr><td style="padding:4px 12px 4px 0;color:#555">${k}</td><td style="padding:4px 0"><b>${esc(v)}</b></td></tr>`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1b1d1c">
  <p>${period[0].toUpperCase() + period.slice(1)} MIS · ${from}${from !== to ? ' to ' + to : ''}</p>
  ${narrative ? `<p>${esc(narrative)}</p>` : ''}
  <table>${row('Calls', d.calls?.total)}${row('Answered within 30 s', (d.calls?.answer_within_30s_pct ?? '–') + '%')}${row('Missed / abandoned', (d.calls?.missed || 0) + ' / ' + (d.calls?.abandoned || 0))}
  ${row('Enquiries to bookings', `${d.funnel?.enquiries} to ${d.funnel?.bookings} (${d.funnel?.conversion_pct ?? 0}%)`)}${row('Completed value', '₹' + (d.revenue?.completed_value || 0))}
  ${row('Collections', '₹' + (d.collections?.collected || 0))}${row('Outstanding', '₹' + (d.outstanding || 0))}${row('New complaints', d.complaints?.new)}${row('Cancellations', (d.cancellations || []).reduce((s: number, x: any) => s + x.n, 0))}</table>
  <p>Full pack with Excel / PDF export is on the dashboard: ${esc(env.APP_URL || '')}/mis</p></div>`;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MIS_FROM || 'MIS <mis@example.com>', to: env.MIS_RECIPIENTS.split(',').map((s) => s.trim()), subject: `HHCS ${period} MIS · ${to}`, html }),
  });
}
