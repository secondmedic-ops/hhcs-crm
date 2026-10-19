// Live telephony state for the signed-in user: incoming-call screen-pop and the active call bar.
// Fed by realtime changes on `calls` (MyOperator webhooks write them; demo mode simulates them).
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q, rpc, isDemo, isLocal, subscribe } from '../lib/db.js';
import { roleAllows, useAuth } from '../lib/auth.jsx';
import { useNow } from '../lib/hooks.js';
import { dur, date, dateTime, STAGE_LABEL, CALL_OUTCOMES } from '../lib/fmt.js';
import Icon from './icons.jsx';
import { Button, Badge, StageBadge, Field, Textarea, ErrorNote, useToast } from './ui.jsx';
import LiveTranscription from './LiveTranscription.jsx';

const Ctx = createContext({ active: null, ringing: [] });
export const useCalls = () => useContext(Ctx);

export function CallProvider({ children }) {
  const { profile } = useAuth();
  const [calls, setCalls] = useState([]);
  const [dismissed, setDismissed] = useState({});
  // everyone who can place a call (same roles as POST /calls/dial) tracks their own live call;
  // the incoming-call pop-up stays with the contact-centre roles that answer the helpline
  const ops = profile && roleAllows(['agent', 'coordinator', 'supervisor', 'medical_desk'], profile.role);
  const takesInbound = profile && roleAllows(['agent', 'coordinator', 'supervisor'], profile.role);

  const load = useCallback(async () => {
    if (!ops) return;
    const since = new Date(Date.now() - 2 * 3600e3).toISOString();
    const rows = await q(db.from('v_calls').select('*').in('status', ['ringing', 'answered']).gte('started_at', since).order('started_at', { ascending: false }).limit(10));
    setCalls(rows.filter((c) => !c.ended_at && (c.agent_id === profile.id || (takesInbound && !c.agent_id && c.direction === 'inbound'))));
  }, [ops, takesInbound, profile?.id]);

  useEffect(() => { load(); if (!ops) return undefined; return subscribe(['calls'], load); }, [load, ops]);

  // an outbound call started from CareDesk shows as active for 10 minutes until MyOperator's record arrives
  const active = calls.find((c) => c.agent_id === profile?.id && c.status === 'answered')
    || calls.find((c) => c.agent_id === profile?.id && c.direction === 'outbound' && Date.now() - new Date(c.started_at).getTime() < 10 * 60e3);
  // Recover a missed live notification while a call is open; stop polling immediately after hang-up.
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => load().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [active?.id, load]);
  // a call still 'ringing' after 10 minutes never got its next event: no pop-up for it
  const ringing = calls.filter((c) => c.status === 'ringing' && c.direction === 'inbound' && !dismissed[c.id] && Date.now() - new Date(c.started_at).getTime() < 10 * 60e3);
  return (
    <Ctx.Provider value={{ active, ringing, reload: load, dismiss: (id) => setDismissed((d) => ({ ...d, [id]: true })) }}>
      {children}
      {ringing[0] && <ScreenPop call={ringing[0]} />}
      {ops && <LiveTranscription call={active} />}
      {ops && !active && <WrapUpGate />}
    </Ctx.Provider>
  );
}

function ScreenPop({ call }) {
  const nav = useNavigate();
  const toast = useToast();
  const { dismiss } = useCalls();
  const now = useNow(1000);
  const [history, setHistory] = useState(null);
  useEffect(() => {
    if (!call.patient_id) { setHistory([]); return; }
    q(db.from('v_cases').select('id,case_no,stage,service_names,created_at,total').eq('patient_id', call.patient_id).order('created_at', { ascending: false }).limit(3))
      .then(setHistory).catch(() => setHistory([]));
  }, [call.patient_id]);
  const { profile } = useAuth();
  const answer = async () => {
    if (isDemo) { const { answerCall } = await import('../demo/sim.js'); await answerCall(call.id); }
    if (isLocal) { const { localAnswer } = await import('../lib/localsim.js'); await localAnswer(call, profile).catch((e) => toast.error(e.message)); }
    dismiss(call.id);
    nav(call.case_id ? `/cases/${call.case_id}` : `/console?call=${call.id}`);
  };
  return (
    <div className="screenpop" role="alertdialog" aria-label="Incoming call">
      <div className="screenpop-head">
        <span className="live-dot" /> <strong>Incoming call</strong>{call.line_label && <Badge kind="info">{call.line_label} line</Badge>}
        <span className="mono small" style={{ marginLeft: 'auto' }}>{dur(Math.max(0, Math.round((now - new Date(call.started_at)) / 1000)))}</span>
      </div>
      <div className="panel-body">
        <div className="mono" style={{ fontSize: 18 }}>{call.customer_number}</div>
        {call.patient_name
          ? <div className="mt-4"><strong>{call.patient_name}</strong> <Badge kind="ok">Known patient</Badge></div>
          : <div className="mt-4 muted">New caller · no patient on file</div>}
        {history?.length > 0 && (
          <div className="mt-12">
            <div className="upper mb-8">Recent cases</div>
            {history.map((h) => (
              <div key={h.id} className="row between small" style={{ padding: '3px 0' }}>
                <span className="mono">{h.case_no}</span><StageBadge stage={h.stage} /><span className="muted">{date(h.created_at)}</span>
              </div>
            ))}
          </div>
        )}
        {call.case_id && <div className="mt-8 small">Open case will load on answer.</div>}
        <div className="row mt-16">
          <Button kind="call" icon="phone" onClick={answer}>{isDemo || isLocal ? 'Answer' : 'Open on screen'}</Button>
          <Button onClick={() => { dismiss(call.id); toast('Call left in queue'); }}>Dismiss</Button>
        </div>
        {!isDemo && !isLocal && <div className="tiny faint mt-8">Answer on your registered phone; this panel follows the call.</div>}
      </div>
    </div>
  );
}

// After a connected call ends the agent picks its outcome before anything else: this dialog cannot be closed, and
// click-to-call / the auto-dialer refuse the next call until it is saved. Missed and failed calls get an automatic
// outcome in the database and never show here. Calls that ended before the rule went live never block.
function WrapUpGate() {
  const toast = useToast();
  const [pending, setPending] = useState(null);
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => rpc('my_pending_wrapup', {}).then((r) => setPending(r || null)).catch(() => {}), []);
  useEffect(() => { load(); return subscribe(['calls'], load); }, [load]);
  useEffect(() => { setOutcome(''); setNote(''); setError(null); }, [pending?.id]);
  if (!pending) return null;
  const save = async () => {
    setSaving(true); setError(null);
    try {
      await rpc('wrap_up_call', { p_call: pending.id, p: { disposition: outcome, notes: note.trim() || null } });
      toast('Call outcome saved');
      await load();
    } catch (e) { setError(e.message); }
    setSaving(false);
  };
  return (
    <div className="scrim">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Call outcome">
        <div className="modal-head"><h2>Call outcome</h2>{pending.pending > 1 && <Badge kind="warn">{pending.pending} calls to wrap up</Badge>}</div>
        <div className="modal-body col gap-12">
          <div className="small">
            {pending.direction === 'inbound' ? 'Inbound' : 'Outbound'} call ended {dateTime(pending.ended_at)} · talk {dur(pending.talk_seconds)}
            {pending.patient_name && <> · <strong>{pending.patient_name}</strong></>}{pending.case_no && <> · <span className="mono">{pending.case_no}</span></>}
          </div>
          <div className="small muted">Pick the outcome before your next call.{pending.callback_id ? ' Close the callback itself on the Callbacks page.' : ''}</div>
          <div className="row wrap gap-8" role="radiogroup" aria-label="Outcome">
            {CALL_OUTCOMES.map(([k, l]) => (
              <Button key={k} size="sm" kind={outcome === k ? 'primary' : undefined} aria-pressed={outcome === k} onClick={() => setOutcome(k)}>{l}</Button>
            ))}
          </div>
          <Field label="Note" hint="optional"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything the next person should know" /></Field>
          <ErrorNote error={error} />
        </div>
        <div className="modal-foot"><Button kind="primary" disabled={!outcome || saving} onClick={save}>{saving ? 'Saving' : 'Save outcome'}</Button></div>
      </div>
    </div>
  );
}

// Bar shown on the console / case while a call is live
export function LiveCallBar({ call }) {
  const now = useNow(1000);
  const [ending, setEnding] = useState(false);
  if (!call) return null;
  const since = call.answered_at || call.started_at;
  const end = async () => {
    setEnding(true);
    if (isLocal) { const { localEnd } = await import('../lib/localsim.js'); await localEnd(call).catch(() => {}); }
    else { const { endCall } = await import('../demo/sim.js'); await endCall(call.id); }
    setEnding(false);
  };
  return (
    <div className="callbar">
      <span className="live-dot" />
      <div className="col" style={{ gap: 0 }}>
        <span className="small" style={{ color: 'var(--side-muted)' }}>{call.direction === 'inbound' ? 'Inbound' : 'Outbound'}{call.line_label ? ` · ${call.line_label} line` : ''} · {call.status === 'ringing' ? 'Ringing' : 'On call'} · recording</span>
        <span className="num">{call.customer_number}{call.patient_name ? ` · ${call.patient_name}` : ''}</span>
      </div>
      <span className="mono" style={{ marginLeft: 'auto', fontSize: 16, color: '#fff' }}>{dur(Math.max(0, Math.round((now - new Date(since)) / 1000)))}</span>
      {(isDemo || isLocal) && <Button kind="hang" size="sm" icon="hang" onClick={end} disabled={ending}>End call</Button>}
    </div>
  );
}

export { STAGE_LABEL, Icon };
