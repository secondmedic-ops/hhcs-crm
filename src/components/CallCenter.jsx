// Live telephony state for the signed-in user: incoming-call screen-pop and the active call bar.
// Fed by realtime changes on `calls` (MyOperator webhooks write them; demo mode simulates them).
import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q, isDemo, isLocal, subscribe } from '../lib/db.js';
import { useAuth } from '../lib/auth.jsx';
import { useNow } from '../lib/hooks.js';
import { dur, date, STAGE_LABEL } from '../lib/fmt.js';
import Icon from './icons.jsx';
import { Button, Badge, StageBadge, Modal, useToast } from './ui.jsx';

const Ctx = createContext({ active: null, ringing: [] });
export const useCalls = () => useContext(Ctx);

export function CallProvider({ children }) {
  const { profile } = useAuth();
  const [calls, setCalls] = useState([]);
  const [dismissed, setDismissed] = useState({});
  const ops = profile && ['agent', 'coordinator', 'supervisor'].includes(profile.role);

  const load = useCallback(async () => {
    if (!ops) return;
    const since = new Date(Date.now() - 2 * 3600e3).toISOString();
    const rows = await q(db.from('v_calls').select('*').in('status', ['ringing', 'answered']).gte('started_at', since).order('started_at', { ascending: false }).limit(10));
    setCalls(rows.filter((c) => c.agent_id === profile.id || (!c.agent_id && c.direction === 'inbound')));
  }, [ops, profile?.id]);

  useEffect(() => { load(); if (!ops) return undefined; return subscribe(['calls'], load); }, [load, ops]);

  // an outbound call started from CareDesk shows as active for 10 minutes until MyOperator's record arrives
  const active = calls.find((c) => c.agent_id === profile?.id && c.status === 'answered')
    || calls.find((c) => c.agent_id === profile?.id && c.direction === 'outbound' && Date.now() - new Date(c.started_at).getTime() < 10 * 60e3);
  // a call still 'ringing' after 10 minutes never got its next event: no pop-up for it
  const ringing = calls.filter((c) => c.status === 'ringing' && c.direction === 'inbound' && !dismissed[c.id] && Date.now() - new Date(c.started_at).getTime() < 10 * 60e3);
  return (
    <Ctx.Provider value={{ active, ringing, reload: load, dismiss: (id) => setDismissed((d) => ({ ...d, [id]: true })) }}>
      {children}
      {ringing[0] && <ScreenPop call={ringing[0]} />}
      <DialSheet />
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
        {!isDemo && !isLocal && <div className="tiny faint mt-8">Answer on your MyOperator phone or app; this panel follows the call.</div>}
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

const EXTENSION_URL = 'https://chromewebstore.google.com/detail/myoperator-click-to-call/hnlocbghekoeogmbhhphhpjldbipmnhd';

/** Dial window: used when MyOperator's Calling API is not available. The number is shown for this call only; the MyOperator
 *  Chrome extension adds its call button next to it (or the agent dials it in the MyOperator app). The call is placed and
 *  recorded by MyOperator, and the call-log sync attaches it to the case within about a minute. */
function DialSheet() {
  const toast = useToast();
  const [d, setD] = useState(null);
  useEffect(() => {
    const on = (e) => setD(e.detail);
    window.addEventListener('caredesk:dial', on);
    return () => window.removeEventListener('caredesk:dial', on);
  }, []);
  if (!d) return null;
  const copy = () => navigator.clipboard?.writeText(d.number).then(() => toast('Number copied'), () => toast.error('Copy failed'));
  return (
    <Modal title={`Call ${d.patient_name || 'patient'}`} onClose={() => setD(null)}
      footer={<><Button onClick={copy}>Copy number</Button><Button kind="primary" onClick={() => setD(null)}>Done</Button></>}>
      <div className="dial-number mono">{d.number}</div>
      <ol className="st-steps small mt-12">
        <li>Click the <strong>MyOperator call button</strong> next to the number above (MyOperator Click to Call extension), or dial it in the <strong>MyOperator app</strong>.</li>
        <li>MyOperator places and records the call from your business number.</li>
        <li>Within about a minute the call, with its recording, appears on this case and patient.</li>
      </ol>
      <div className="tiny faint mt-12">{d.reason}. Showing the number is written to the access log. No extension yet? <a href={EXTENSION_URL} target="_blank" rel="noreferrer">Add MyOperator Click to Call</a> to Chrome or Brave and sign in to MyOperator.</div>
    </Modal>
  );
}
