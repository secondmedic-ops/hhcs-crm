// Hinduja live dashboard (slide 9): real-time KPIs with drill-down to the underlying cases.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { inr, num, pct, istDayRange, ago, time, SLA_LABEL } from '../lib/fmt.js';
import { PageHead, Panel, Kpi, Segmented, Badge, StageBadge, SlaBadge, Countdown, TableSkeleton, Empty, AiTag } from '../components/ui.jsx';
import { Bars, HBars, Funnel, Meter } from '../components/charts.jsx';
import StaffWorkspace from '../components/StaffWorkspace.jsx';

const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7 days'], ['30d', '30 days']];
const rangeOf = (r) => ({ today: istDayRange(0), yesterday: istDayRange(-1), '7d': istDayRange(-6, 7), '30d': istDayRange(-29, 30) }[r]);

export default function Dashboard() {
  const nav = useNavigate();
  const { workspace, isClient, can } = useAuth();
  const [range, setRange] = useState('today');
  const now = useNow(30000);
  const [from, to] = rangeOf(range);
  const live = ['calls', 'cases', 'callbacks', 'escalations', 'complaints', 'payments', 'approvals'];
  const { data: k, error } = useLoad(() => rpc('dashboard_kpis', { p_from: from, p_to: to }), [range], live);
  const watch = useLoad(() => q(db.from('v_cases').select('id,case_no,patient_name,stage,priority,sla_state,next_sla_due,next_sla_key,zone_name,service_names,owner_code,open_escalations')
    .not('stage', 'in', '(closed,cancelled)').neq('sla_state', 'ok').order('next_sla_due', { ascending: true }).limit(8)), [], ['cases']);
  const esc = useLoad(() => q(db.from('v_escalations').select('*').neq('status', 'resolved').order('raised_at', { ascending: false }).limit(5)), [], ['escalations']);

  const c = k?.calls || {};
  const answeredPct = c.total ? (100 * c.answered) / c.total : null;
  const caseLink = (params) => `/cases?${new URLSearchParams(params)}`;
  const hourly = Array.from({ length: 16 }, (_, i) => {
    const h = i + 7;
    const row = (k?.hourly || []).find((x) => x.h === h) || {};
    return { h: String(h).padStart(2, '0'), calls: row.calls || 0, missed: row.missed || 0 };
  });

  return (
    <>
      <PageHead title="Live dashboard" sub={<>{workspace?.name} · updated {k ? ago(k.generated_at, now) : '…'} · every number opens the cases behind it</>}>
        <Segmented options={RANGES} value={range} onChange={setRange} />
      </PageHead>
      {can('supervisor') && <div className="mb-12"><StaffWorkspace /></div>}
      {error && <div className="badge danger mb-12">{error}</div>}

      <div className="kpis">
        <Kpi label="Calls" value={k && num(c.total)} detail={k && `${c.inbound} in · ${c.outbound} out`} to="/calls" />
        <Kpi label="Answered" value={k && pct(answeredPct)} detail={k && `${c.answered_30s} within 30 s`} tone={answeredPct != null && answeredPct < 90 ? 'warn' : 'ok'} to="/calls" />
        <Kpi label="Missed / abandoned" value={k && `${c.missed}/${c.abandoned}`} detail="auto-queued for callback" tone={c.missed + c.abandoned > 0 ? 'warn' : ''} to="/callbacks" />
        <Kpi label="Callbacks pending" value={k && num(k.callbacks_pending)} detail={k && `${k.callbacks_overdue} overdue`} tone={k?.callbacks_overdue ? 'danger' : ''} to="/callbacks" />
        <Kpi label="Bookings" value={k && num(k.bookings)} detail={k && inr(k.commercial.booking_value)} to={caseLink({ stage: 'booking,deployment,completion,payment,closure,closed' })} />
        <Kpi label="In progress" value={k && num(k.in_progress)} detail="deployed or on site" to={caseLink({ stage: 'deployment,completion' })} />
        <Kpi label="Within SLA" value={k && pct(k.sla.pct, 0)} detail={k && `${k.sla.breached} breached · ${k.at_risk} at risk`} tone={k?.sla.pct != null && k.sla.pct < 90 ? 'warn' : 'ok'} to={caseLink({ sla_state: 'breached' })} />
        <Kpi label="Open complaints" value={k && num(k.complaints_open)} detail={k && `${k.complaints_new} new in period`} tone={k?.complaints_open ? 'warn' : ''} to="/complaints" />
        <Kpi label="Clinical escalations" value={k && num(k.escalations_open.clinical)} detail={k && `${k.escalations_open.operational} operational open`} tone={k?.escalations_open.clinical ? 'danger' : 'ok'} to="/escalations" />
        <Kpi label="Collections" value={k && inr(k.collections)} detail={k && `${k.unreconciled} unreconciled`} to={caseLink({ stage: 'payment' })} />
        <Kpi label="Outstanding" value={k && inr(k.commercial.outstanding)} detail="completed, not collected" tone={k?.commercial.outstanding > 0 ? 'warn' : ''} to={caseLink({ stage: 'payment' })} />
        <Kpi label="Approvals waiting" value={k && num(k.approvals_pending)} detail={isClient ? 'needs your decision' : 'with Hinduja approver'} tone={k?.approvals_pending ? 'warn' : ''} to="/approvals" />
      </div>

      <div className="grid g-main-side mt-16">
        <div className="col gap-12">
          <div className="grid g2">
            <Panel title="Enquiry funnel" sub="Enquiry → quote → booking → completion">
              {k ? <Funnel steps={[
                { label: 'Enquiries', value: k.funnel.enquiries, onClick: () => nav(caseLink({ from: from.slice(0, 10) })) },
                { label: 'Quoted', value: k.funnel.quoted },
                { label: 'Booked', value: k.funnel.booked },
                { label: 'Completed', value: k.funnel.completed },
                { label: 'Closed', value: k.funnel.closed },
              ]} /> : <TableSkeleton rows={5} cols={1} />}
              {k && <div className="small muted mt-12">Conversion {pct(k.funnel.enquiries ? (100 * k.funnel.booked) / k.funnel.enquiries : null)} · {k.funnel.cancelled} cancelled</div>}
            </Panel>
            <Panel title="SLA compliance" sub="Draft matrix · targets for joint finalisation">
              {k ? <div className="col gap-12">
                {k.sla_by_policy.filter((s) => s.met + s.breached + s.running > 0).slice(0, 7).map((s) => (
                  <Meter key={s.key} label={<span>{s.label} <span className="faint">{s.key === 'missed_callback' ? 'per callback deadline' : `≤ ${s.target_minutes >= 120 ? `${s.target_minutes / 60} h` : `${s.target_minutes} min`}`}</span></span>}
                    value={s.met + s.breached ? (100 * s.met) / (s.met + s.breached) : null} target={90} />
                ))}
                {!k.sla_by_policy.some((s) => s.met + s.breached + s.running) && <Empty title="No SLA events in this period" />}
              </div> : <TableSkeleton rows={5} cols={1} />}
            </Panel>
          </div>

          <Panel title="Calls by hour" sub="Answered and missed / abandoned, IST" actions={<span className="row small muted"><span className="dot" style={{ color: 'var(--accent)' }} /> calls <span className="dot" style={{ color: 'var(--danger)' }} /> missed</span>}>
            <Bars data={hourly} x="h" y="calls" y2="missed" height={120} labelEvery={1} />
          </Panel>

          <Panel title="Needs attention now" sub="Open cases at risk or past SLA, soonest deadline first" tight>
            {watch.loading ? <TableSkeleton rows={4} cols={6} /> : watch.data?.length ? (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>Case</th><th>Patient</th><th>Stage</th><th>Zone</th><th>SLA</th><th>Next deadline</th><th>Owner</th></tr></thead>
                <tbody>{watch.data.map((r) => (
                  <tr key={r.id} className="click" onClick={() => nav(`/cases/${r.id}`)}>
                    <td className="mono">{r.case_no}{r.priority === 'urgent' && <> <Badge kind="danger">U</Badge></>}</td>
                    <td className="truncate" style={{ maxWidth: 180 }}>{r.patient_name}</td>
                    <td><StageBadge stage={r.stage} /></td>
                    <td>{r.zone_name || '–'}</td>
                    <td><SlaBadge state={r.sla_state} /></td>
                    <td>{r.next_sla_due ? <Countdown due={r.next_sla_due} label={r.next_sla_key} /> : <span className="muted small">–</span>}</td>
                    <td className="mono small">{r.owner_code || '–'}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <Empty title="All open cases are within SLA" />}
          </Panel>
        </div>

        <div className="col gap-12">
          <Panel title="Open escalations" actions={<a href="/escalations" onClick={(e) => { e.preventDefault(); nav('/escalations'); }} className="small">All</a>} tight>
            {esc.loading ? <div className="panel-body"><TableSkeleton rows={3} cols={1} /></div> : esc.data?.length ? esc.data.map((e) => (
              <div key={e.id} className="list-row click" onClick={() => nav(e.case_id ? `/cases/${e.case_id}` : '/escalations')}>
                <Badge kind={['clinical', 'emergency'].includes(e.type) ? 'danger' : 'warn'}>L{e.level} · {e.type}</Badge>
                <div className="grow"><div className="small truncate">{e.trigger_text}</div><div className="tiny muted">{e.case_no || '–'} · {ago(e.raised_at, now)}</div></div>
              </div>
            )) : <Empty title="No open escalations" />}
          </Panel>

          <Panel title="Geography" sub="Enquiries by zone in period">
            {k ? (k.by_zone.length ? <HBars data={k.by_zone} label="zone" value="cases" sub={(d) => `· ${d.booked} booked${d.breached ? ` · ${d.breached} breached` : ''}`} /> : <Empty title="No enquiries yet" />) : <TableSkeleton rows={4} cols={1} />}
          </Panel>

          <Panel title="Service mix" sub="Sample, X-ray, ECG by booked value">
            {k ? (k.by_service.length ? <HBars data={k.by_service.map((s) => ({ ...s, category: { lab: 'Sample collection', xray: 'Portable X-ray', ecg: 'ECG at home', visit: 'Visit charges', other: 'Other' }[s.category] || s.category }))} label="category" value="value" format={inr} /> : <Empty title="No services yet" />) : <TableSkeleton rows={3} cols={1} />}
          </Panel>

          <Panel title="Channel mix">
            {k ? <div className="row wrap gap-12">{Object.entries(k.by_channel).map(([ch, n]) => <div key={ch} className="col" style={{ gap: 0 }}><span className="mono" style={{ fontSize: 18 }}>{n}</span><span className="small muted">{ch}</span></div>)}
              {!Object.keys(k.by_channel).length && <span className="muted small">No enquiries yet</span>}</div> : <TableSkeleton rows={1} cols={3} />}
          </Panel>
          <div className="small faint">Times in IST · {time(now)} · <AiTag>AI</AiTag> summaries appear on each case and call.</div>
        </div>
      </div>
    </>
  );
}
export { SLA_LABEL };
