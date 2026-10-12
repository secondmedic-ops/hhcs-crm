// Callback queue (slide 11): every missed or abandoned call is queued with a 10-minute callback target.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { dial } from '../lib/api.js';
import { num, pct, ago, time, istDayRange } from '../lib/fmt.js';
import { PageHead, Panel, Kpi, Tabs, Button, Badge, Countdown, TableSkeleton, Empty, ErrorNote, Confirm, useAction, useToast } from '../components/ui.jsx';

const COLS = 'id,call_id,reason,due_at,status,assigned_to,assignee_name,attempts,last_attempt_at,completed_at,created_at,patient_id,patient_name,number,open_case_id';
const REASON = { missed: ['Missed', 'danger'], abandoned: ['Abandoned', 'warn'], requested: ['Requested', 'info'], followup: ['Follow-up', ''] };

export default function Callbacks() {
  const nav = useNavigate();
  const now = useNow(15000);
  const { profile, can } = useAuth();
  const canAct = can('agent', 'coordinator', 'supervisor');
  const [tab, setTab] = useState('pending');
  const [unreach, setUnreach] = useState(null);
  const [run, busy] = useAction();
  const toast = useToast();

  const { data, loading, error } = useLoad(async () => {
    const [from] = istDayRange(0);
    const [pending, today, unreachable] = await Promise.all([
      q(db.from('v_callbacks').select(COLS).in('status', ['pending', 'in_progress']).order('due_at', { ascending: true }).limit(200)),
      q(db.from('v_callbacks').select(COLS).in('status', ['done', 'unreachable']).gte('completed_at', from).order('completed_at', { ascending: false }).limit(300)),
      q(db.from('v_callbacks').select(COLS).eq('status', 'unreachable').order('completed_at', { ascending: false }).limit(100)),
    ]);
    return { pending, done: today.filter((x) => x.status === 'done'), today, unreachable };
  }, [], ['callbacks', 'calls']);

  const overdue = data?.pending.filter((x) => new Date(x.due_at) < now).length;
  const met = data?.done.filter((x) => new Date(x.completed_at) <= new Date(x.due_at)).length;
  const metPct = data?.done.length ? (100 * met) / data.done.length : null;
  const avgMin = data?.done.length ? data.done.reduce((a, x) => a + (new Date(x.completed_at) - new Date(x.created_at)), 0) / data.done.length / 60000 : null;
  const rows = data ? data[tab] : null;

  const callBack = (cb) => run(async () => { await dial({ callback_id: cb.id }); toast.ok('Dialling via MyOperator. Pick up on your phone.'); });
  const markDone = (cb) => run(() => rpc('callback_update', { p_id: cb.id, p_status: 'done', p_note: null }), 'Callback marked done');
  const markUnreachable = (reason) => run(async () => {
    const cb = unreach;
    await rpc('callback_update', { p_id: cb.id, p_status: 'unreachable', p_note: reason });
    // keep the reason on the patient timeline (callback_update does not store the note)
    if (cb.patient_id) {
      await q(db.from('interactions').insert({
        workspace_id: profile.workspace_id, patient_id: cb.patient_id, case_id: cb.open_case_id || null, channel: 'note', direction: 'internal',
        actor_id: profile.id, actor_label: profile.agent_code || profile.full_name, summary: `Callback unreachable after ${cb.attempts || 0} attempt${cb.attempts === 1 ? '' : 's'}`, body: reason,
      }));
    }
    setUnreach(null);
  }, 'Marked unreachable');

  return (
    <>
      <PageHead title="Callback queue" sub="Missed and abandoned calls are queued automatically · call back within 10 minutes · numbers are masked for agents" />
      <ErrorNote error={error} />

      <div className="kpis mb-16">
        <Kpi label="Pending" value={data && num(data.pending.length)} detail={data && `${data.pending.filter((x) => x.status === 'in_progress').length} being dialled`} tone={data?.pending.length ? 'warn' : 'ok'} onClick={() => setTab('pending')} />
        <Kpi label="Overdue" value={data && num(overdue)} detail="past the 10-minute target" tone={overdue ? 'danger' : 'ok'} onClick={() => setTab('pending')} />
        <Kpi label="Met within SLA today" value={data && pct(metPct)} detail={data && `${met} of ${data.done.length} done on time`} tone={metPct != null && metPct < 90 ? 'warn' : 'ok'} onClick={() => setTab('done')} />
        <Kpi label="Avg time to callback" value={data && (avgMin == null ? '–' : `${avgMin.toFixed(1)} min`)} detail="raised to done, today" tone={avgMin != null && avgMin > 10 ? 'warn' : ''} />
        <Kpi label="Unreachable today" value={data && num(data.today.filter((x) => x.status === 'unreachable').length)} detail="after attempts, with reason" onClick={() => setTab('unreachable')} />
      </div>

      <Panel tight>
        <div className="panel-body" style={{ paddingBottom: 0 }}>
          <Tabs value={tab} onChange={setTab} tabs={[
            ['pending', 'Pending', data?.pending.length],
            ['done', 'Done today', data?.done.length],
            ['unreachable', 'Unreachable', data?.unreachable.length],
          ]} />
        </div>
        {loading ? <TableSkeleton rows={6} cols={8} /> : !rows?.length ? (
          <Empty title={tab === 'pending' ? 'No callbacks waiting' : tab === 'done' ? 'No callbacks completed today' : 'No unreachable callbacks'}>
            {tab === 'pending' ? 'Missed and abandoned inbound calls appear here the moment they end.' : null}
          </Empty>
        ) : (
          <div className="table-wrap"><table className="t">
            <thead><tr>
              <th>Number</th><th>Patient</th><th>Reason</th><th>Raised</th>
              <th>{tab === 'pending' ? 'Due' : 'Outcome'}</th><th className="num">Attempts</th><th>Assignee</th><th>Case</th>
              {canAct && tab === 'pending' && <th />}
            </tr></thead>
            <tbody>{rows.map((cb) => {
              const late = cb.completed_at && new Date(cb.completed_at) > new Date(cb.due_at);
              const [rl, rk] = REASON[cb.reason] || [cb.reason, ''];
              return (
                <tr key={cb.id}>
                  <td className="mono">{cb.number}</td>
                  <td className="truncate" style={{ maxWidth: 180 }}>
                    {cb.patient_id ? <a href={`/patients/${cb.patient_id}`} onClick={(e) => { e.preventDefault(); nav(`/patients/${cb.patient_id}`); }}>{cb.patient_name}</a> : <span className="muted">Unknown caller</span>}
                  </td>
                  <td><Badge kind={rk}>{rl}</Badge></td>
                  <td className="nowrap"><span title={time(cb.created_at)}>{ago(cb.created_at, now)}</span></td>
                  <td className="nowrap">
                    {tab === 'pending' ? <Countdown due={cb.due_at} compact />
                      : cb.status === 'unreachable' ? <Badge kind="warn">Unreachable · {time(cb.completed_at)}</Badge>
                        : <Badge kind={late ? 'danger' : 'ok'}>{late ? 'Late' : 'On time'} · {time(cb.completed_at)}</Badge>}
                    {cb.status === 'in_progress' && <> <Badge kind="info">Dialling</Badge></>}
                  </td>
                  <td className="num">{cb.attempts}</td>
                  <td className="small">{cb.assignee_name || <span className="faint">–</span>}</td>
                  <td>{cb.open_case_id ? <a className="small" href={`/cases/${cb.open_case_id}`} onClick={(e) => { e.preventDefault(); nav(`/cases/${cb.open_case_id}`); }}>Open case</a> : <span className="faint">–</span>}</td>
                  {canAct && tab === 'pending' && (
                    <td className="nowrap right">
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <Button size="xs" kind="call" icon="phone" disabled={busy} onClick={() => callBack(cb)}>Call back</Button>
                        <Button size="xs" icon="check" disabled={busy} onClick={() => markDone(cb)}>Mark done</Button>
                        <Button size="xs" disabled={busy} onClick={() => setUnreach(cb)}>Unreachable</Button>
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Panel>
      {!canAct && <div className="small muted mt-8">View only: callbacks are worked by the SecondMedic contact centre.</div>}

      {unreach && (
        <Confirm title="Mark callback unreachable" confirmLabel="Mark unreachable" busy={busy} needReason reasonLabel="What happened on each attempt"
          onClose={() => setUnreach(null)} onConfirm={markUnreachable}>
          <div className="small">
            <span className="mono">{unreach.number}</span>{unreach.patient_name ? ` · ${unreach.patient_name}` : ''} · {unreach.attempts} attempt{unreach.attempts === 1 ? '' : 's'} so far.
            The callback leaves the queue. If the patient calls again a new entry is created.
          </div>
        </Confirm>
      )}
    </>
  );
}
