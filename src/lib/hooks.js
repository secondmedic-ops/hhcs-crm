import { useEffect, useRef, useState, useCallback } from 'react';
import { subscribe } from './db.js';

// Load data with an async function; re-runs on deps change and whenever a live table changes.
// const { data, loading, error, reload } = useLoad(() => q(db.from('v_cases').select('*')), [filter], ['cases'])
export function useLoad(fn, deps = [], liveTables = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const fnRef = useRef(fn); fnRef.current = fn;
  const seq = useRef(0);
  const run = useCallback(async (silent) => {
    const my = ++seq.current;
    if (!silent) setState((s) => ({ ...s, loading: s.data == null, error: null }));
    try {
      const data = await fnRef.current();
      if (my === seq.current) setState({ data, loading: false, error: null });
    } catch (e) {
      if (my === seq.current) setState((s) => ({ ...s, loading: false, error: e.message || String(e) }));
    }
  }, []);
  useEffect(() => { run(false); }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!liveTables.length) return undefined;
    let t = null;
    const off = subscribe(liveTables, () => { clearTimeout(t); t = setTimeout(() => run(true), 250); });
    return () => { clearTimeout(t); off(); };
  }, [liveTables.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, reload: () => run(true), setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

// Re-render every `ms` (for SLA countdowns, "x min ago")
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function useKey(combo, handler) {
  useEffect(() => {
    const h = (e) => {
      const want = combo.toLowerCase().split('+');
      const key = want[want.length - 1];
      const mod = want.includes('mod') ? (e.metaKey || e.ctrlKey) : true;
      if (mod && e.key.toLowerCase() === key) { e.preventDefault(); handler(e); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [combo, handler]);
}
