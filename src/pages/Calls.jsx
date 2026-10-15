// Calls & recordings (slides 10, 12): MyOperator call log, recordings for authorised roles, AI call intelligence and QA.
import { Fragment, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db, q, rpc, isDemo } from '../lib/db.js';
import { useLoad, useDebounced } from '../lib/hooks.js';
import { roleAllows, useAuth } from '../lib/auth.jsx';
import { aiCall, recordingUrl } from '../lib/api.js';
import { num, pct, dur, time, date, dateTime, istDayRange } from '../lib/fmt.js';
import {
  PageHead, Panel, Kpi, Segmented, Button, Badge, TableSkeleton, Skeleton, Empty, ErrorNote, AiTag, Drawer, Field, Input, Select, Textarea, Check, useAction,
} from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { SUMMARY_ROLES } from '../components/AiCallState.jsx';

const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', '7 days']];
const rangeOf = (r) => ({ today: istDayRange(0), yesterday: istDayRange(-1), '7d': istDayRange(-6, 7) }[r]);
const STATUS = { completed: ['Completed', 'ok'], answered: ['On call', 'accent'], ringing: ['Ringing', 'info'], missed: ['Missed', 'danger'], abandoned: ['Abandoned', 'warn'], failed: ['Failed', ''] };
const SENTIMENT = { positive: 'ok', neutral: '', negative: 'danger', distressed: 'warn', mixed: 'warn' };
const REC_ROLES = ['supervisor', 'coordinator', 'client_manager', 'client_clinical', 'medical_desk'];
const QA_KEYS = [['greeting', 'Greeting'], ['consent', 'Consent'], ['price_accuracy', 'Price accuracy'], ['empathy', 'Empathy'], ['closure', 'Closure']];
const COLS = 'id,direction,customer_number,patient_id,patient_name,agent_id,agent_label,status,started_at,answered_at,ring_seconds,talk_seconds,has_recording,ai_sentiment,ai_flags,ai_processed_at,qa_pct,case_id,case_no,line_label';

export default function Calls() {
  const { profile } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [range, setRange] = useState('today');
  const [direction, setDirection] = useState('');
  const [status, setStatus] = useState('');
  const [agent, setAgent] = useState('');
  const [flagged, setFlagged] = useState(false);
  const [text, setText] = useState('');
  const [shown, setShown] = useState(200);
  const search = useDebounced(text.trim(), 300);
  const openId = sp.get('call');
  const setOpen = (id) => setSp(id ? { call: id } : {});

  const agents = useLoad(() => q(db.from('profiles').select('id,full_name,agent_code').eq('role', 'agent').is('active', true).order('full_name')), []);
  const { data, loading, error } = useLoad(() => {
    const [from, to] = rangeOf(range);
    let x = db.from('v_calls').select(COLS).gte('started_at', from).lt('started_at', to);
    if (direction) x = x.eq('direction', direction);
    if (status) x = x.eq('status', status);
    if (agent) x = x.eq('agent_id', agent);
    if (search) { const s = search.replace(/[,()*]/g, ' '); x = x.or(`patient_name.ilike.*${s}*,case_no.ilike.*${s}*`); }
    return q(x.order('started_at', { ascending: false }).limit(1000));
  }, [range, direction, status, agent, search], ['calls']);
  useEffect(() => { setShown(200); }, [range, direction, status, agent, search, flagged]);

  const rows = (data || []).filter((r) => !flagged || r.ai_flags?.length);
  const k = (() => {
    if (!data) return null;
    const answered = rows.filter((r) => ['answered', 'completed'].includes(r.status));
    const talked = rows.filter((r) => r.talk_seconds > 0);
    const qa = rows.filter((r) => r.qa_pct != null);
    return {
      total: rows.length, inbound: rows.filter((r) => r.direction === 'inbound').length,
      answeredPct: rows.length ? (100 * answered.length) / rows.length : null,
      in30: answered.length ? (100 * answered.filter((r) => (r.ring_seconds ?? 0) <= 30).length) / answered.length : null,
      lost: rows.filter((r) => ['missed', 'abandoned'].includes(r.status)).length,
      avgTalk: talked.length ? talked.reduce((a, r) => a + r.talk_seconds, 0) / talked.length : null,
      qa: qa.length ? qa.reduce((a, r) => a + Number(r.qa_pct), 0) / qa.length : null, qaN: qa.length,
    };
  })();

  return (
    <>
      <PageHead title="Calls & recordings" sub={<>MyOperator call log · AI summaries and QA on every answered call · {profile.role === 'agent' ? 'your calls and unassigned inbound calls' : 'all agents'}</>}>
        <Segmented options={RANGES} value={range} onChange={setRange} />
      </PageHead>
      <ErrorNote error={error} />

      <div className="kpis mb-16">
        <Kpi label="Calls" value={k && num(k.total)} detail={k && `${k.inbound} in · ${k.total - k.inbound} out`} />
        <Kpi label="Answered" value={k && pct(k.answeredPct)} tone={k?.answeredPct != null && k.answeredPct < 90 ? 'warn' : 'ok'} detail="of all calls" />
        <Kpi label="Answered within 30 s" value={k && pct(k.in30)} tone={k?.in30 != null && k.in30 < 90 ? 'warn' : 'ok'} detail="of answered calls" />
        <Kpi label="Missed + abandoned" value={k && num(k.lost)} tone={k?.lost ? 'warn' : ''} detail="queued for callback" to="/callbacks" />
        <Kpi label="Avg talk" value={k && dur(k.avgTalk)} detail="answered calls" />
        <Kpi label="Avg QA score" value={k && pct(k.qa)} tone={k?.qa != null && k.qa < 75 ? 'warn' : ''} detail={k && `${k.qaN} scored`} />
      </div>

      <Panel tight>
        <div className="panel-body filters">
          <div className="calls-search"><Input className="sm" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search patient or case ID" aria-label="Search" /></div>
          <Select className="sm" style={{ width: 'auto' }} value={direction} onChange={(e) => setDirection(e.target.value)} options={[['inbound', 'Inbound'], ['outbound', 'Outbound']]} placeholder="Any direction" aria-label="Direction" />
          <Select className="sm" style={{ width: 'auto' }} value={status} onChange={(e) => setStatus(e.target.value)} options={[['completed', 'Completed'], ['missed', 'Missed'], ['abandoned', 'Abandoned'], ['failed', 'Failed']]} placeholder="Any status" aria-label="Status" />
          {profile.role !== 'agent' && <Select className="sm" style={{ width: 'auto' }} value={agent} onChange={(e) => setAgent(e.target.value)} options={(agents.data || []).map((a) => [a.id, `${a.agent_code ? a.agent_code + ' · ' : ''}${a.full_name}`])} placeholder="All agents" aria-label="Agent" />}
          <Check label={<span className="small">AI flags only</span>} checked={flagged} onChange={(e) => setFlagged(e.target.checked)} />
          <span className="small muted" style={{ marginLeft: 'auto' }}>{data ? `${rows.length} call${rows.length === 1 ? '' : 's'}${data.length >= 1000 ? ' (first 1000)' : ''}` : ''}</span>
        </div>
        {loading ? <TableSkeleton rows={8} cols={10} /> : !rows.length ? <Empty title="No calls match">Change the date range or clear the filters.</Empty> : (
          <div className="table-wrap"><table className="t">
            <thead><tr>
              <th>Time</th><th /><th>Number</th><th>Patient</th><th>Agent</th><th>Status</th><th className="num">Ring</th><th className="num">Talk</th><th>Sentiment</th><th className="num">QA</th><th>Case</th>
            </tr></thead>
            <tbody>{rows.slice(0, shown).map((r) => (
              <tr key={r.id} className={`click ${openId === r.id ? 'sel' : ''}`} onClick={() => setOpen(r.id)}>
                <td className="mono nowrap">{range === '7d' ? `${date(r.started_at)} ` : ''}{time(r.started_at)}</td>
                <td title={r.direction}><Icon name={r.direction === 'inbound' ? 'callin' : 'callout'} size={14} className={r.direction === 'inbound' ? '' : 'muted'} /></td>
                <td className="mono">{r.customer_number || '–'}{r.line_label && <div className="tiny faint" style={{ fontFamily: 'inherit' }}>{r.line_label} line</div>}</td>
                <td className="truncate" style={{ maxWidth: 170 }}>{r.patient_name || <span className="faint">Unknown</span>}</td>
                <td className="small truncate" style={{ maxWidth: 150 }}>{r.agent_label || <span className="faint">Queue</span>}</td>
                <td className="nowrap"><StatusBadge s={r.status} />{r.ai_flags?.length > 0 && <> <Badge kind="danger" title={r.ai_flags.join(', ')}>{r.ai_flags.length} flag{r.ai_flags.length > 1 ? 's' : ''}</Badge></>}</td>
                <td className="num">{r.ring_seconds ?? '–'}</td>
                <td className="num">{r.talk_seconds ? dur(r.talk_seconds) : '–'}</td>
                <td>{r.ai_sentiment ? <Badge kind={SENTIMENT[r.ai_sentiment]}>{r.ai_sentiment}</Badge> : <span className="faint">–</span>}</td>
                <td className="num">{r.qa_pct != null ? pct(r.qa_pct) : '–'}</td>
                <td className="mono small nowrap">{r.case_no || <span className="faint">–</span>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        {!loading && rows.length > shown && <div className="panel-body center"><Button size="sm" onClick={() => setShown(shown + 200)}>Show {Math.min(200, rows.length - shown)} more of {rows.length - shown}</Button></div>}
      </Panel>

      {openId && <CallDrawer id={openId} onClose={() => setOpen(null)} />}
    </>
  );
}

const StatusBadge = ({ s }) => { const [l, kind] = STATUS[s] || [s, '']; return <Badge kind={kind}>{l}</Badge>; };

function CallDrawer({ id, onClose }) {
  const nav = useNavigate();
  const { profile, can } = useAuth();
  const [run, busy] = useAction();
  const call = useLoad(() => q(db.from('v_calls').select('*').eq('id', id).maybeSingle()), [id], ['calls']);
  const qa = useLoad(() => q(db.from('qa_reviews').select('*').eq('call_id', id).order('created_at', { ascending: false })), [id], ['calls', 'qa_reviews']);
  const [src, setSrc] = useState(null);
  const [recBusy, setRecBusy] = useState(false);
  const [showTx, setShowTx] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const c = call.data;

  useEffect(() => { setSrc(null); setShowTx(false); }, [id]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);

  const loadRecording = async () => {
    setRecBusy(true);
    const url = await run(() => recordingUrl(id));
    if (url) {
      setSrc(url);
      // production logs this server side when the Worker streams the file
      if (isDemo) rpc('log_access', { p_action: 'play_recording', p_entity: 'call', p_entity_id: id, p_meta: { case_no: c?.case_no || null } }).catch(() => {});
    }
    setRecBusy(false);
  };
  const analyse = async () => {
    setAnalysing(true);
    await run(() => aiCall(id), 'AI summary ready');
    setAnalysing(false);
    call.reload(); qa.reload();
  };

  const ex = c?.ai_extracted || {};
  const exRows = Object.entries(ex).filter(([key, v]) => key !== 'service_ids' && v != null && v !== '' && !(Array.isArray(v) && !v.length));
  const fmtVal = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'object' ? JSON.stringify(v) : String(v));

  return (
    <Drawer title={c ? <span className="row"><Icon name={c.direction === 'inbound' ? 'callin' : 'callout'} />{c.direction === 'inbound' ? 'Inbound' : 'Outbound'} call · {time(c.started_at)}</span> : 'Call'} onClose={onClose}
      footer={c && !c.case_id && can('agent', 'coordinator', 'supervisor') ? <Button kind="primary" icon="plus" onClick={() => nav(`/console?call=${c.id}`)}>Create enquiry from this call</Button> : null}>
      {call.loading ? <Skeleton lines={10} /> : !c ? <Empty title="Call not found">It may be outside what your role can see.</Empty> : (
        <div className="col gap-16">
          <dl className="kv">
            <dt>Number</dt><dd className="mono">{c.customer_number || '–'}</dd>
            <dt>Patient</dt><dd>{c.patient_id ? <a href={`/patients/${c.patient_id}`} onClick={(e) => { e.preventDefault(); nav(`/patients/${c.patient_id}`); }}>{c.patient_name}</a> : <span className="muted">Not linked</span>}</dd>
            <dt>Case</dt><dd>{c.case_id ? <a className="mono" href={`/cases/${c.case_id}`} onClick={(e) => { e.preventDefault(); nav(`/cases/${c.case_id}`); }}>{c.case_no}</a> : <span className="muted">No case yet</span>}</dd>
            <dt>Agent</dt><dd>{c.agent_label || <span className="muted">Not assigned</span>}</dd>
            <dt>Status</dt><dd><StatusBadge s={c.status} /></dd>
            <dt>Started</dt><dd className="mono">{dateTime(c.started_at)}</dd>
            <dt>Ring · talk</dt><dd className="mono">{c.ring_seconds ?? '–'} s · {dur(c.talk_seconds)}</dd>
            {c.disposition && <><dt>Disposition</dt><dd>{c.disposition}</dd></>}
            {c.notes && <><dt>Notes</dt><dd>{c.notes}</dd></>}
            <dt>Provider</dt><dd className="small muted">{c.provider} · {c.did_number ? `${c.line_label || 'Line'} · ${c.did_number}` : 'click-to-call'}</dd>
          </dl>

          <section>
            <div className="section-title mb-8">Recording</div>
            {!c.has_recording ? <div className="small muted">No recording for this call{['missed', 'abandoned', 'failed'].includes(c.status) ? ' (not answered)' : ''}.</div>
              : !roleAllows(REC_ROLES, profile.role) ? <div className="small muted row"><Icon name="lock" size={14} /> Recordings are available to supervisors. Ask your supervisor for a QA review.</div>
                : src ? <audio controls src={src} style={{ width: '100%' }} autoPlay />
                  : <div className="row wrap"><Button size="sm" icon="play" disabled={recBusy} onClick={loadRecording}>{recBusy ? 'Loading…' : 'Load recording'}</Button><span className="tiny faint">Each play is written to the access log.</span></div>}
          </section>

          <section>
            <div className="row between mb-8">
              <div className="section-title row">Call intelligence <AiTag /></div>
              {c.ai_processed_at && <span className="tiny faint">analysed {time(c.ai_processed_at)}</span>}
            </div>
            {analysing ? <Skeleton lines={4} /> : !c.ai_processed_at ? (
              <div className="ai-box">
                <div className={`small${c.ai_status === 'failed' ? ' danger-text' : ''}`}>{!c.has_recording && !c.has_live_transcript ? 'No recording or finished live transcript, so there is nothing to summarise.'
                  : c.ai_status === 'processing' ? 'Summarising now: Gemini is listening to the recording.'
                    : c.ai_status === 'failed' ? `Summary failed: ${c.ai_error || 'unknown error'}`
                      : c.ai_status === 'skipped' ? `Not summarised: ${c.ai_error || 'too short'}.` : 'Not summarised yet. It runs by itself within a few minutes of the call.'}</div>
                {(c.has_recording || c.has_live_transcript) && c.status === 'completed' && c.ai_status !== 'processing' && can(...SUMMARY_ROLES) && <Button className="mt-8" size="sm" icon="ai" disabled={busy} onClick={analyse}>{c.ai_status === 'failed' ? 'Retry AI summary' : 'Run AI summary'}</Button>}
                {c.live_transcript && <div className="transcript mt-8">{c.live_transcript}</div>}
              </div>
            ) : (
              <div className="ai-box col gap-12">
                {c.ai_summary && <div>{c.ai_summary}</div>}
                <div className="row wrap">
                  {c.ai_intent && <Badge kind="outline">Intent · {c.ai_intent.replace(/_/g, ' ')}</Badge>}
                  {c.ai_sentiment && <Badge kind={SENTIMENT[c.ai_sentiment]}>Sentiment · {c.ai_sentiment}</Badge>}
                  {(c.ai_flags || []).map((fl) => <Badge key={fl} kind="danger"><Icon name="flag" size={11} />{fl.replace(/_/g, ' ')}</Badge>)}
                </div>
                {exRows.length > 0 && (
                  <div>
                    <div className="tiny muted mb-8">Extracted fields</div>
                    <dl className="kv small">{exRows.map(([key, v]) => <Fragment key={key}><dt>{key.replace(/_/g, ' ')}</dt><dd>{fmtVal(v)}</dd></Fragment>)}</dl>
                  </div>
                )}
                {c.transcript && (
                  <div>
                    <Button size="xs" kind="ghost" icon={showTx ? 'down' : 'chevron'} onClick={() => setShowTx(!showTx)}>{showTx ? 'Hide transcript' : 'Show transcript'}</Button>
                    {showTx && <div className="transcript mt-8">{c.transcript}</div>}
                  </div>
                )}
                <div className="tiny faint">AI output is advisory. Check against the recording before acting.</div>
              </div>
            )}
          </section>

          <section>
            <div className="section-title mb-8">QA scorecard</div>
            {qa.loading ? <Skeleton lines={3} /> : !qa.data?.length ? <Empty title="Not scored yet">{c.status === 'completed' ? 'AI scores answered calls after analysis.' : 'Only answered calls are scored.'}</Empty> : (
              <div className="col">
                {qa.data.map((r) => (
                  <div key={r.id} className="qa-card">
                    <div className="row between">
                      <span className="row"><strong className="mono">{pct(r.total_pct)}</strong>{r.ai_generated ? <AiTag>AI score</AiTag> : <Badge kind="outline">Supervisor</Badge>}</span>
                      <span className="tiny muted">{dateTime(r.created_at)}</span>
                    </div>
                    <div className="qa-grid mt-8">
                      {QA_KEYS.map(([key, l]) => (
                        <div key={key} className="qa-cell"><div className="tiny muted">{l}</div><div className={`mono ${r[key] != null && r[key] <= 2 ? 'danger-text' : ''}`}>{r[key] ?? '–'}<span className="faint">/5</span></div></div>
                      ))}
                    </div>
                    {r.notes && <div className="small mt-8">{r.notes}</div>}
                    {r.coaching_action && <div className="small mt-4"><span className="muted">Coaching:</span> {r.coaching_action}</div>}
                  </div>
                ))}
              </div>
            )}
            {roleAllows(['supervisor'], profile.role) && c.status === 'completed' && <QaForm call={c} onSaved={() => { qa.reload(); call.reload(); }} />}
          </section>
        </div>
      )}
    </Drawer>
  );
}

function QaForm({ call, onSaved }) {
  const { profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [s, setS] = useState({ greeting: '', consent: '', price_accuracy: '', empathy: '', closure: '', notes: '', coaching_action: '' });
  const [run, busy] = useAction();
  const filled = QA_KEYS.every(([key]) => s[key] !== '');
  const total = filled ? Math.round((QA_KEYS.reduce((a, [key]) => a + Number(s[key]), 0) / 25) * 1000) / 10 : null;
  const save = async () => {
    const ok = await run(async () => {
      await q(db.from('qa_reviews').insert({
        workspace_id: profile.workspace_id, call_id: call.id, agent_id: call.agent_id, reviewer_id: profile.id,
        ...Object.fromEntries(QA_KEYS.map(([key]) => [key, Number(s[key])])), total_pct: total,
        notes: s.notes.trim() || null, coaching_action: s.coaching_action.trim() || null, // ai_generated defaults to false
      }));
      return true;
    }, 'QA review saved');
    if (ok) { setOpen(false); setS({ greeting: '', consent: '', price_accuracy: '', empathy: '', closure: '', notes: '', coaching_action: '' }); onSaved(); }
  };
  if (!open) return <Button className="mt-12" size="sm" icon="plus" onClick={() => setOpen(true)}>Add manual review</Button>;
  return (
    <div className="qa-card mt-12">
      <div className="row between mb-8"><strong>Manual review</strong><span className="mono">{total != null ? pct(total, 1) : '–'}</span></div>
      <div className="qa-grid">
        {QA_KEYS.map(([key, l]) => (
          <Field key={key} label={l}><Select className="sm" value={s[key]} onChange={(e) => setS({ ...s, [key]: e.target.value })} options={[0, 1, 2, 3, 4, 5].map((n) => [String(n), String(n)])} placeholder="–" /></Field>
        ))}
      </div>
      <Field label="Notes" className="mt-8"><Textarea rows={2} value={s.notes} onChange={(e) => setS({ ...s, notes: e.target.value })} /></Field>
      <Field label="Coaching action" hint="what the agent should do differently" className="mt-8"><Input value={s.coaching_action} onChange={(e) => setS({ ...s, coaching_action: e.target.value })} /></Field>
      <div className="row mt-12" style={{ justifyContent: 'flex-end' }}>
        <Button size="sm" onClick={() => setOpen(false)}>Cancel</Button>
        <Button size="sm" kind="primary" disabled={!filled || busy} onClick={save}>Save review</Button>
      </div>
    </div>
  );
}
