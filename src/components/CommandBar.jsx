// Ctrl/Cmd+K: jump anywhere, find a case/patient, or ask in plain language
// ("urgent cases in Andheri at risk today") · the AI turns it into a filter.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q } from '../lib/db.js';
import { aiCommand } from '../lib/api.js';
import { NAV, useAuth } from '../lib/auth.jsx';
import { useDebounced } from '../lib/hooks.js';
import Icon from './icons.jsx';
import { AiTag, StageBadge } from './ui.jsx';

export default function CommandBar({ onClose }) {
  const nav = useNavigate();
  const { profile } = useAuth();
  const [text, setText] = useState('');
  const [hits, setHits] = useState([]);
  const [sel, setSel] = useState(0);
  const [thinking, setThinking] = useState(false);
  const [explain, setExplain] = useState('');
  const inputRef = useRef(null);
  const dq = useDebounced(text, 180);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    let live = true;
    if (dq.trim().length < 2) { setHits([]); return; }
    const like = `*${dq.trim()}*`;
    Promise.all([
      q(db.from('v_cases').select('id,case_no,patient_name,stage,service_names').or(`case_no.ilike.${like},patient_name.ilike.${like}`).order('created_at', { ascending: false }).limit(6)).catch(() => []),
      q(db.from('v_patients').select('id,full_name,mrn,locality').or(`full_name.ilike.${like},mrn.ilike.${like}`).limit(4)).catch(() => []),
    ]).then(([c, p]) => live && setHits([...c.map((x) => ({ kind: 'case', ...x })), ...p.map((x) => ({ kind: 'patient', ...x }))]));
    return () => { live = false; };
  }, [dq]);

  const pages = useMemo(() => NAV.filter((n) => n.roles.includes(profile?.role))
    .filter((n) => !text || n.label.toLowerCase().includes(text.toLowerCase())), [text, profile?.role]);

  const items = [
    ...(text.trim().length > 3 ? [{ kind: 'ai', label: `Ask: “${text.trim()}”` }] : []),
    ...hits,
    ...pages.map((p) => ({ kind: 'page', ...p })),
  ];

  const run = async (it) => {
    if (!it) return;
    if (it.kind === 'page') { nav(it.to); onClose(); return; }
    if (it.kind === 'case') { nav(`/cases/${it.id}`); onClose(); return; }
    if (it.kind === 'patient') { nav(`/patients/${it.id}`); onClose(); return; }
    if (it.kind === 'ai') {
      setThinking(true);
      try {
        const r = await aiCommand(text.trim());
        setExplain(r.explain || '');
        if (r.action === 'filter_cases' || r.action === 'search') {
          const sp = new URLSearchParams();
          Object.entries(r.filters || {}).forEach(([k, v]) => sp.set(k, [].concat(v).join(',')));
          nav(`/cases?${sp}`);
        } else if (r.action === 'new_enquiry') nav('/console?new=1');
        else nav(r.route || '/');
        onClose();
      } catch (e) { setExplain(e.message); } finally { setThinking(false); }
    }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cmd" role="dialog" aria-label="Command bar">
        <input ref={inputRef} value={text} placeholder="Search cases, patients, pages · or ask: “urgent cases in Thane at risk today”"
          onChange={(e) => { setText(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === 'Enter') run(items[sel]);
          }} />
        <div className="cmd-list">
          {thinking && <div className="cmd-item"><AiTag>thinking</AiTag><span className="muted">Understanding your request…</span></div>}
          {explain && !thinking && <div className="cmd-item small muted">{explain}</div>}
          {items.map((it, i) => (
            <div key={it.kind + (it.id || it.to || i)} className={`cmd-item ${i === sel ? 'on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => run(it)}>
              {it.kind === 'ai' && <><AiTag /><span>{it.label}</span></>}
              {it.kind === 'case' && <><Icon name="folder" /><span className="mono">{it.case_no}</span><span className="grow truncate">{it.patient_name} · <span className="muted">{it.service_names}</span></span><StageBadge stage={it.stage} /></>}
              {it.kind === 'patient' && <><Icon name="person" /><span className="grow">{it.full_name} <span className="muted small">{it.mrn} · {it.locality}</span></span></>}
              {it.kind === 'page' && <><Icon name={it.icon} /><span className="grow">{it.label}</span><span className="faint small">Go to</span></>}
            </div>
          ))}
        </div>
        <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
          <span className="small muted"><span className="kbd">↑</span> <span className="kbd">↓</span> move · <span className="kbd">Enter</span> open · <span className="kbd">Esc</span> close</span>
          <AiTag>AI assist</AiTag>
        </div>
      </div>
    </div>
  );
}
