import { useEffect, useRef, useState, useCallback } from 'react';
import { subscribe } from './db.js';

// In-memory query cache for instant screen transitions (SWR: Stale-While-Revalidate).
// Prevents cascading skeleton screens when returning to previously visited pages.
const queryCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes fresh window

// Global invalidation on live database updates
if (typeof window !== 'undefined') {
  subscribe([], (changedTable) => {
    if (!changedTable) return;
    for (const [k, entry] of queryCache.entries()) {
      if (
        changedTable === '*' ||
        (entry.liveTables && entry.liveTables.includes(changedTable)) ||
        k.includes(`'${changedTable}'`) ||
        k.includes(`"${changedTable}"`)
      ) {
        queryCache.delete(k);
      }
    }
  });
}

function computeCacheKey(fn, deps) {
  try {
    const fnStr = fn.toString().replace(/\s+/g, ' ');
    const depsStr = JSON.stringify(deps);
    return `${fnStr}::${depsStr}`;
  } catch {
    return null;
  }
}

// Load data with an async function; re-runs on deps change and whenever a live table changes.
// Uses in-memory SWR caching: cached data renders immediately with 0ms delay,
// while a silent background revalidation ensures data freshness.
// const { data, loading, error, reload } = useLoad(() => q(db.from('v_cases').select('*')), [filter], ['cases'])
export function useLoad(fn, deps = [], liveTables = []) {
  const cacheKey = computeCacheKey(fn, deps);
  const cached = cacheKey ? queryCache.get(cacheKey) : null;
  const isFresh = cached && (Date.now() - cached.at < CACHE_TTL_MS);

  const [state, setState] = useState(() => (
    isFresh
      ? { data: cached.data, loading: false, error: null }
      : { data: null, loading: true, error: null }
  ));

  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const run = useCallback(async (silent) => {
    const my = ++seq.current;
    if (!silent) {
      setState((s) => ({ ...s, loading: s.data == null, error: null }));
    }
    try {
      const data = await fnRef.current();
      if (my === seq.current) {
        if (cacheKey && data !== undefined) {
          queryCache.set(cacheKey, { data, at: Date.now(), liveTables });
        }
        setState({ data, loading: false, error: null });
      }
    } catch (e) {
      if (my === seq.current) {
        setState((s) => ({ ...s, loading: false, error: e.message || String(e) }));
      }
    }
  }, [cacheKey, liveTables]);

  useEffect(() => {
    const key = computeCacheKey(fnRef.current, deps);
    const c = key ? queryCache.get(key) : null;
    if (c && Date.now() - c.at < CACHE_TTL_MS) {
      setState({ data: c.data, loading: false, error: null });
      run(true);
    } else {
      run(false);
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!liveTables.length) return undefined;
    let t = null;
    const off = subscribe(liveTables, () => {
      if (cacheKey) queryCache.delete(cacheKey);
      clearTimeout(t);
      t = setTimeout(() => run(true), 250);
    });
    return () => { clearTimeout(t); off(); };
  }, [liveTables.join(','), cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    ...state,
    reload: () => {
      if (cacheKey) queryCache.delete(cacheKey);
      return run(false);
    },
    setData: (d) => setState((s) => {
      const next = typeof d === 'function' ? d(s.data) : d;
      if (cacheKey && queryCache.has(cacheKey)) {
        const c = queryCache.get(cacheKey);
        queryCache.set(cacheKey, { ...c, data: next, at: Date.now() });
      }
      return { ...s, data: next };
    }),
  };
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
