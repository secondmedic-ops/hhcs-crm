import { useEffect, useRef, useState } from 'react';
import { isDemo } from '../lib/db.js';
import { createLiveTranscription } from '../lib/live-transcription.js';
import { Button, Badge, Skeleton } from './ui.jsx';

export default function LiveTranscription({ call }) {
  const session = useRef(null);
  const callId = useRef(null);
  const [state, setState] = useState('idle');
  const [text, setText] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState('');
  const [consent, setConsent] = useState(false);
  const [visible, setVisible] = useState(false);
  const finish = async () => {
    try { const r = await session.current?.stop(); setError(r?.unconfirmed ? 'The last preview did not finalise. Saved words exclude that preview; check the recording.' : ''); }
    catch { setState('unsaved'); setError('Transcript is not saved yet. Retry saving before leaving this page.'); }
  };
  useEffect(() => {
    if (session.current && call?.id !== callId.current && !['saved', 'unsaved', 'interrupted'].includes(state)) finish();
  }, [call?.id, state]);
  useEffect(() => () => session.current?.dispose(), []);
  useEffect(() => { setConsent(false); }, [call?.id]);
  useEffect(() => {
    const warn = (e) => { if (session.current && !['idle', 'saved'].includes(state)) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [state]);
  const start = () => {
    setError(''); setText(''); setInterim(''); callId.current = call.id;
    session.current = createLiveTranscription(call.id, (u) => { setText(u.transcript); setInterim(u.interim); setState(u.state); }, setError);
    session.current.start();
  };
  if (!call && !visible) return null;
  if (!visible) return <div className="live-transcription-launch"><Button size="sm" onClick={() => setVisible(true)}>Live transcript</Button></div>;
  const active = ['connecting', 'listening', 'reconnecting', 'saving'].includes(state);
  return (
    <aside className="live-transcription" aria-label="Live call transcription">
      <div className="row between mb-8"><strong>AI Summary: live transcript</strong><Badge kind={state === 'listening' ? 'ok' : 'outline'}>{state}</Badge></div>
      <div className="tiny muted mb-8">Gemini 3.5 Transcribe Live · microphone audio</div>
      {!active && state === 'idle' && <div className="small mb-8">Put the phone on speaker so the microphone hears both people. A headset microphone usually hears only you. Start near the beginning of the call.</div>}
      {state === 'connecting' ? <Skeleton lines={2} /> : <div className="transcript live-transcription-text" role="log" aria-label="Transcript">{text || 'Spoken words appear here.'}{interim && <div className="muted">{interim}</div>}</div>}
      {error && <div className="small danger-text mt-8" role="alert">{error}</div>}
      {state === 'saved' && <div className="tiny muted mt-8">Transcript saved. When the call ends, automatic AI Summary uses these words. Review against the recording before acting.</div>}
      {!active && call && !isDemo && <label className="small row gap-8 mt-8"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />Both people have agreed to transcription by Google.</label>}
      {isDemo && <div className="small muted mt-8">Live transcription connects on the live CRM with a Gemini key.</div>}
      <div className="row wrap gap-8 mt-8">
        {!active && call && <Button size="sm" kind="primary" disabled={!consent || isDemo || ['unsaved', 'interrupted'].includes(state)} onClick={start}>{state === 'saved' ? 'Continue transcription' : 'Start transcription'}</Button>}
        {active && <Button size="sm" disabled={state === 'saving'} onClick={finish}>Stop and save</Button>}
        {['unsaved', 'interrupted'].includes(state) && <Button size="sm" onClick={async () => { try { await session.current.retrySave(); setState('saved'); setError(''); } catch { setError('Saving failed. Keep this panel open and check the connection.'); } }}>Retry saving</Button>}
        {!active && !['unsaved', 'interrupted'].includes(state) && <Button size="sm" kind="ghost" onClick={() => { setVisible(false); setState('idle'); session.current = null; }}>Close</Button>}
      </div>
    </aside>
  );
}
