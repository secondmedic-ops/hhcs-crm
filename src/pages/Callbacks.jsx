// Callback queue (slide 11): every missed or abandoned call is queued. With the auto-dialer on (Settings > Telephony),
// CareDesk rings a free, Available agent and bridges the patient in; the buttons stay as manual overrides.
// A callback is reached when its own call connects (leaves the queue, SLA met) and closed when the agent records an outcome.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { dial } from '../lib/api.js';
import { num, pct, ago, time, istDayRange } from '../lib/fmt.js';
import { PageHead, Panel, Kpi, Tabs, Button, Badge, Countdown, TableSkeleton, Empty, ErrorNote, Confirm, Modal, Field, Select, Textarea, useAction, useToast } from '../components/ui.jsx';

const COLS = 'id,call_id,reason,due_at,status,assigned_to,assignee_name,attempts,last_attempt_at,completed_at,created_at,patient_id,patient_name,number,open_case_id,next_attempt_at,auto_dialled,reached_at,outcome,outcome_note,notes';
const REASON = { missed: ['Missed', 'danger'], abandoned: ['Abandoned', 'warn'], requested: ['Requested', 'info'], followup: ['Follow-up', ''] };
const OUTCOMES = [['resolved', 'Resolved'], ['follow_up', 'Follow-up needed'], ['wrong_number', 'Wrong number'], ['not_needed', 'No longer needed']];
const OUTCOME = Object.fromEntries(OUTCOMES);
const EMPTY = { pending: 'No callbacks waiting', outcome: 'Every reached callback has an outcome', done: 'No callbacks closed today', unreachable: 'No unreachable callbacks' };

export default function Callbacks() {
  const nav = useNavigate();
  const now = useNow(15000);
  const { profile, can } = useAuth();
  const canAct = can('agent', 'coordinator', 'supervisor');
  const [tab, setTab] = useState('pending');
  const [unreach, setUnreach] = useState(null);
  const [closing, setClosing] = useState(null);
  const [run, busy] = useAction();
  const toast = useToast();

  const { data, loading, error } = useLoad(async () => {
    const [from] = istDayRange(0);
    const [pending, outcome, today, reached, unreachable] = await Promise.all([
      q(db.from('v_callbacks').select(COLS).in('status', ['pending', 'in_progress']).order('due_at', { ascending: true }).limit(200)),
      q(db.from('v_callbacks').select(COLS).eq('status', 'reached').order('reached_at', { ascending: true }).limit(200)),
      q(db.from('v_callbacks').select(COLS).in('status', ['done', 'unreachable']).gte('completed_at', from).order('completed_at', { ascending: false }).limit(300)),
      q(db.from('v_callbacks').select('id,created_at,due_at,reached_at').gte('reached_at', from).limit(300)),
      q(db.from('v_callbacks').select(COLS).eq('status', 'unreachable').order('completed_at', { ascending: false }).limit(100)),
    ]);
    return { pending, outcome, done: today.filter((x) => x.status === 'done'), today, reached, unreachable };
  }, [], ['callbacks', 'calls']);
  const auto = useLoad(() => rpc('autodial_settings', {}).catch(() => null), [], ['workspaces', 'profiles', 'callbacks']);
  const ad = auto.data;

  // SLA and speed are measured to the moment the patient was reached, not to when the outcome was recorded
  const overdue = data?.pending.filter((x) => new Date(x.due_at) < now).length;
  const met = data?.reached.filter((x) => new Date(x.reached_at) <= new Date(x.due_at)).length;
  const metPct = data?.reached.length ? (100 * met) / data.reached.length : null;
  const avgMin = data?.reached.length ? data.reached.reduce((a, x) => a + (new Date(x.reached_at) - new Date(x.created_at)), 0) / data.reached.length / 60000 : null;
  const rows = data ? data[tab] : null;
  const onTime = (cb) => new Date(cb.reached_at) <= new Date(cb.due_at);

  const callBack = (cb) => run(async () => { await dial({ callback_id: cb.id }); toast.ok('Dialling via MyOperator. Pick up on your phone.'); });
  // Pending and Needs outcome rows carry right-hand actions; unreachable rows have the call option right in the outcome column
  const actions = canAct && (tab === 'pending' || tab === 'outcome');
  const closeWith = ({ outcome, note }) => run(async () => {
    await rpc('callback_close', { p_id: closing.id, p_outcome: outcome, p_note: note || null });
    setClosing(null);
  }, 'Callback closed');
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
      <PageHead title="Callback queue" sub={ad?.enabled
        ? `Auto-dialer on · ${ad.buffer_minutes}-minute retry window from queue creation, up to ${ad.max_attempts} attempts · numbers are masked for agents`
        : 'Missed and abandoned calls are queued automatically · use each callback’s displayed deadline · numbers are masked for agents'} />
      <ErrorNote error={error} />
      {ad?.enabled && ad.calling_configured === false && <div className="small warn-text mb-12">Calling configuration is incomplete. Callbacks remain pending without an attempt. Ask an administrator to check Settings &gt; Telephony &amp; integrations.</div>}
      {ad?.enabled && ad.agents_available === 0 && data?.pending.length > 0 && (
        <div className="small warn-text mb-12">No agent is marked Available, so the auto-dialer is waiting. Switch to Available in the top bar to take callbacks.</div>
      )}

      <div className="kpis mb-16">
        <Kpi label="Pending" value={data && num(data.pending.length)} detail={data && `${data.pending.filter((x) => x.status === 'in_progress').length} being dialled`} tone={data?.pending.length ? 'warn' : 'ok'} onClick={() => setTab('pending')} />
        <Kpi label="Overdue" value={data && num(overdue)} detail="past each callback’s deadline" tone={overdue ? 'danger' : 'ok'} onClick={() => setTab('pending')} />
        <Kpi label="Needs outcome" value={data && num(data.outcome.length)} detail="patient reached, outcome not recorded" tone={data?.outcome.length ? 'warn' : 'ok'} onClick={() => setTab('outcome')} />
        <Kpi label="Reached within SLA today" value={data && pct(metPct)} detail={data && `${met} of ${data.reached.length} reached on time`} tone={metPct != null && metPct < 90 ? 'warn' : 'ok'} onClick={() => setTab('done')} />
        <Kpi label="Avg time to callback" value={data && (avgMin == null ? '–' : `${avgMin.toFixed(1)} min`)} detail="raised to patient reached, today"  />
        <Kpi label="Unreachable today" value={data && num(data.today.filter((x) => x.status === 'unreachable').length)} detail="closed by policy or manually, see reason" onClick={() => setTab('unreachable')} />
      </div>

      <Panel tight>
        <div className="panel-body" style={{ paddingBottom: 0 }}>
          <Tabs value={tab} onChange={setTab} tabs={[
            ['pending', 'Pending', data?.pending.length],
            ['outcome', 'Needs outcome', data?.outcome.length],
            ['done', 'Closed today', data?.done.length],
            ['unreachable', 'Unreachable', data?.unreachable.length],
          ]} />
        </div>
        {loading ? <TableSkeleton rows={6} cols={8} /> : !rows?.length ? (
          <Empty title={EMPTY[tab]}>
            {tab === 'pending' ? 'Missed and abandoned inbound calls appear here the moment they end.'
              : tab === 'outcome' ? 'A callback lands here when its call connects, until the agent records what happened.' : null}
          </Empty>
        ) : (
          <div className="table-wrap"><table className="t">
            <thead><tr>
              <th>Number</th><th>Patient</th><th>Reason</th><th>Raised</th>
              <th>{tab === 'pending' ? 'Due' : tab === 'outcome' ? 'Reached' : 'Outcome'}</th><th className="num">Attempts</th><th>Assignee</th><th>Case</th>
              {actions && <th />}
            </tr></thead>
            <tbody>{rows.map((cb) => {
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
                      : cb.status === 'unreachable' ? (
                        <div className="row" style={{ alignItems: 'center' }}>
                          <Badge kind="warn">Unreachable · {time(cb.completed_at)}</Badge>
                          {canAct && <Button size="xs" kind="call" icon="phone" disabled={busy} onClick={() => callBack(cb)}>Call again</Button>}
                        </div>
                      )
                        : tab === 'outcome' ? <Badge kind={onTime(cb) ? 'ok' : 'danger'}>{onTime(cb) ? 'On time' : 'Late'} · {time(cb.reached_at)}</Badge>
                          : <>
                            <Badge kind={cb.outcome === 'follow_up' ? 'warn' : ''}>{OUTCOME[cb.outcome] || 'Closed'}</Badge>
                            <div className="tiny muted">{cb.reached_at ? `Reached ${time(cb.reached_at)} · ${onTime(cb) ? 'on time' : 'late'}` : 'Closed without a call'}</div>
                            {cb.outcome_note && <div className="tiny muted truncate" style={{ maxWidth: 220 }} title={cb.outcome_note}>{cb.outcome_note}</div>}
                          </>}
                    {cb.notes && <div className="tiny muted" style={{ maxWidth: 280, whiteSpace: 'normal' }}>{cb.notes}</div>}
                    {cb.status === 'in_progress' && <> <Badge kind="info">{cb.auto_dialled ? `Auto-dialling${cb.assignee_name ? ' · ' + cb.assignee_name : ''}` : 'Dialling'}</Badge></>}
                    {cb.status === 'pending' && cb.next_attempt_at && (
                      <div className="tiny muted">{ad?.calling_configured === false ? 'Waiting for calling configuration' : !ad?.enabled ? 'Automatic calling is off' : new Date(cb.next_attempt_at) <= now ? 'Eligible: waiting for scheduler and a free agent' : `Next eligible ${time(cb.next_attempt_at)}`}</div>
                    )}
                  </td>
                  <td className="num">{cb.attempts}</td>
                  <td className="small">{cb.assignee_name || <span className="faint">–</span>}</td>
                  <td>{cb.open_case_id ? <a className="small" href={`/cases/${cb.open_case_id}`} onClick={(e) => { e.preventDefault(); nav(`/cases/${cb.open_case_id}`); }}>Open case</a> : <span className="faint">–</span>}</td>
                  {actions && (
                    <td className="nowrap right">
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        {cb.status === 'pending' && <Button size="xs" kind="call" icon="phone" disabled={busy} onClick={() => callBack(cb)}>Call back</Button>}
                        <Button size="xs" icon="check" kind={tab === 'outcome' ? 'primary' : undefined} disabled={busy} onClick={() => setClosing(cb)}>Record outcome</Button>
                        {tab === 'pending' && <Button size="xs" disabled={busy} onClick={() => setUnreach(cb)}>Unreachable</Button>}
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
      {closing && <OutcomeModal cb={closing} busy={busy} onClose={() => setClosing(null)} onSave={closeWith} />}
    </>
  );
}

function OutcomeModal({ cb, busy, onClose, onSave }) {
  const [outcome, setOutcome] = useState(cb.status === 'reached' ? 'resolved' : '');
  const [note, setNote] = useState('');
  const needNote = outcome === 'follow_up';
  return (
    <Modal title="Record callback outcome" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" disabled={busy || !outcome || (needNote && !note.trim())} onClick={() => onSave({ outcome, note: note.trim() })}>Close callback</Button>
    </>}>
      <div className="small">
        <span className="mono">{cb.number}</span>{cb.patient_name ? ` · ${cb.patient_name}` : ''}
        {cb.reached_at ? ` · reached at ${time(cb.reached_at)}` : ' · not reached by a CareDesk call'}.
        The outcome goes on the patient timeline.
      </div>
      <Field label="Outcome" className="mt-12">
        <Select value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Choose" options={OUTCOMES} />
      </Field>
      <Field label={needNote ? 'What follow-up is needed' : 'Note'} hint={needNote ? null : 'optional'} className="mt-12">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}
