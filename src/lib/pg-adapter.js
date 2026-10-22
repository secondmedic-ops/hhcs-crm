// Query builder used by every screen: db.from('v_cases').select('id,case_no').eq('stage','pricing').order('created_at')
// It records a QuerySpec (table, columns, filters ...) instead of SQL. A transport runs it:
//   apiTransport   production and the local test: reads are batched into one /api/v1/batch call, writes go to
//                  /api/v1/data/{table}, actions to /api/v1/rpc/{fn}; the Worker builds the SQL and applies the roles.
//   demoTransport  in-browser demo: the same translator (cloudflare/src/domain/query.ts) on PGlite, as the picked user.
import { buildQuery, shape, toParam, ident } from '../../cloudflare/src/domain/query.ts';
import { api } from '../api.ts';

const bus = new EventTarget();
export const emitChange = (table) => bus.dispatchEvent(new CustomEvent('change', { detail: table }));
export const onChange = (fn) => {
  const h = (e) => fn(e.detail);
  bus.addEventListener('change', h);
  return () => bus.removeEventListener('change', h);
};

export const cleanError = (m = '') => String(m).replace(/^error:\s*/i, '').replace(/\s*CONTEXT:[\s\S]*$/, '');

class Query {
  constructor(client, table) {
    this.c = client;
    this.spec = { table, op: 'select', cols: '*', filters: [], or: [], orders: [], limit: null, offset: null, count: null, head: false, mode: 'many', returning: false };
  }
  select(cols = '*', opts = {}) {
    if (this.spec.op === 'select') { this.spec.cols = cols; this.spec.count = opts.count || null; this.spec.head = !!opts.head; }
    else this.spec.returning = true;
    return this;
  }
  insert(rows) { this.spec.op = 'insert'; this.spec.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows, opts = {}) { this.spec.op = 'upsert'; this.spec.rows = Array.isArray(rows) ? rows : [rows]; this.spec.onConflict = opts.onConflict || 'id'; return this; }
  update(patch) { this.spec.op = 'update'; this.spec.patch = patch; return this; }
  delete() { this.spec.op = 'delete'; return this; }
  _f(col, op, val) { this.spec.filters.push({ col, op, val: val === undefined ? null : val }); return this; }
  eq(c, v) { return this._f(c, 'eq', v); }
  neq(c, v) { return this._f(c, 'neq', v); }
  gt(c, v) { return this._f(c, 'gt', v); }
  gte(c, v) { return this._f(c, 'gte', v); }
  lt(c, v) { return this._f(c, 'lt', v); }
  lte(c, v) { return this._f(c, 'lte', v); }
  like(c, v) { return this._f(c, 'like', v); }
  ilike(c, v) { return this._f(c, 'ilike', v); }
  is(c, v) { return this._f(c, 'is', v); }
  in(c, arr) { return this._f(c, 'in', (arr || []).map(String)); }
  contains(c, arr) { return this._f(c, 'contains', arr); }
  not(c, op, v) { return this._f(c, op === 'is' ? 'not_is' : op === 'in' ? 'not_in' : 'not_eq', v); }
  or(expr) { this.spec.or.push(expr); return this; }
  match(obj) { Object.entries(obj).forEach(([k, v]) => this.eq(k, v)); return this; }
  order(col, { ascending = true, nullsFirst } = {}) {
    this.spec.orders.push({ col, asc: ascending, nulls: nullsFirst === undefined ? undefined : nullsFirst ? 'first' : 'last' });
    return this;
  }
  limit(n) { this.spec.limit = Number(n); return this; }
  range(a, b) { this.spec.offset = Number(a); this.spec.limit = Number(b) - Number(a) + 1; return this; }
  single() { this.spec.mode = 'single'; return this; }
  maybeSingle() { this.spec.mode = 'maybe'; return this; }
  then(res, rej) { return this.c.exec(this.spec).then(res, rej); }
}

// Must equal READ_RPC in cloudflare/src/services/data.ts (test read-rpc-sync). An action missing here is treated as a
// write: after it returns every screen reloads, and a loader that calls it (my_pending_wrapup in the call bar,
// provider_portal) then reloads itself in a loop, about once a second (21 Oct 2026: this used up the daily query budget).
const READ_ONLY_RPC = new Set(['customer_feedback_summary', 'provider_portal', 'case_gates', 'render_template', 'dashboard_kpis', 'mis_report', 'autodial_settings', 'transition_metrics', 'care_plan_sheet',
  'rate_import_check', 'case_margins', 'margin_report', 'my_pending_wrapup']);

// ---------------------------------------------------------------- production / local test: through the Worker
export function createApiClient() {
  // reads issued in the same tick travel together (one request, one database transaction)
  let queue = [];
  let timer = null;
  const flush = async () => {
    const jobs = queue; queue = []; timer = null;
    try {
      const { results } = await api.batch(jobs.map((j) => j.op));
      jobs.forEach((j, i) => j.resolve(results[i] || { data: null, count: null, error: 'No answer' }));
    } catch (e) {
      jobs.forEach((j) => j.resolve({ data: null, count: null, error: e.message }));
    }
  };
  const enqueue = (op) => new Promise((resolve) => {
    queue.push({ op, resolve });
    if (queue.length >= 40) { clearTimeout(timer); flush(); } else if (!timer) timer = setTimeout(flush, 0);
  });

  const client = {
    from: (t) => new Query(client, t),
    async exec(spec) {
      if (spec.op === 'select') {
        const r = await enqueue({ kind: 'select', spec });
        return { data: r.data, count: r.count, error: r.error ? { message: r.error } : null };
      }
      try {
        const r = await api.data(spec.table, spec);
        emitChange(spec.table);
        return { data: r.data, count: r.count, error: r.error ? { message: r.error } : null };
      } catch (e) {
        return { data: null, count: null, error: { message: e.message } };
      }
    },
    async rpc(fn, args = {}) {
      if (READ_ONLY_RPC.has(fn)) {
        const r = await enqueue({ kind: 'rpc', fn, args });
        return { data: r.data, error: r.error ? { message: r.error } : null };
      }
      try {
        const r = await api.rpc(fn, args);
        if (fn !== 'log_access') emitChange('*'); // this screen at once; other screens hear it from the live hub
        return { data: r.data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  return client;
}

// ---------------------------------------------------------------- in-browser demo: PGlite with the real migrations
export function createDemoClient(pg, session) {
  // serialise all access: PGlite is a single connection
  let chain = Promise.resolve();
  const run = (sql, params = []) => {
    const job = chain.then(() => pg.transaction(async (tx) => {
      const uid = session.userId();
      if (uid) {
        await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', 'authenticated', true)`, [uid]);
        await tx.exec('set local role caredesk_app');
      } else {
        await tx.query(`select set_config('request.jwt.claim.role', 'service_role', true)`);
      }
      const r = await tx.query(sql, params);
      return r.rows;
    }));
    chain = job.catch(() => {});
    return job;
  };

  const client = {
    run,
    from: (t) => new Query(client, t),
    async exec(spec) {
      try {
        const q = buildQuery(spec);
        const rows = await run(q.text, q.params);
        const count = q.countText ? (await run(q.countText, q.countParams))[0].n : null;
        if (spec.op !== 'select') emitChange(spec.table);
        const out = shape(spec, rows, count);
        return { data: out.data, count: out.count, error: out.error ? { message: out.error } : null };
      } catch (e) {
        return { data: null, count: null, error: { message: cleanError(e.message) } };
      }
    },
    async rpc(fn, args = {}) {
      try {
        const keys = Object.keys(args);
        const sql = `select ${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')}) as r`;
        // as the Worker: a list of objects (import rows) is one jsonb argument; plain lists stay Postgres arrays
        const param = (v) => (Array.isArray(v) && v.some((x) => x !== null && typeof x === 'object') ? JSON.stringify(v) : toParam(v));
        const rows = await run(sql, keys.map((k) => param(args[k])));
        if (!READ_ONLY_RPC.has(fn) && fn !== 'log_access') emitChange('*');
        return { data: rows[0]?.r ?? null, error: null };
      } catch (e) {
        return { data: null, error: { message: cleanError(e.message) } };
      }
    },
  };
  return client;
}
