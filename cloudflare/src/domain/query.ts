// Screens describe a query as JSON (a QuerySpec: table, columns, filters, order, limit). This file turns that
// description into parameterised SQL. It never accepts SQL text: every table and column name must be a plain
// identifier, every value becomes a $n parameter. Used by the Worker (cloudflare/src/services/data.ts) and by the
// in-browser demo database (src/lib/pg-adapter.js), so both behave the same.

export type FilterOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'ilike' | 'is' | 'in' | 'contains' | 'not_is' | 'not_in' | 'not_eq';
export interface Filter { col: string; op: FilterOp; val?: unknown }
export interface Order { col: string; asc?: boolean; nulls?: 'first' | 'last' }
export type QueryOp = 'select' | 'insert' | 'upsert' | 'update' | 'delete';

export interface QuerySpec {
  table: string;
  op?: QueryOp;
  cols?: string;                 // "*" or "a,b,c"
  count?: 'exact' | null;
  head?: boolean;                // count only, no rows
  filters?: Filter[];
  or?: string[];                 // PostgREST style groups: "a.eq.x,b.ilike.*y*"
  orders?: Order[];
  limit?: number | null;
  offset?: number | null;
  mode?: 'many' | 'single' | 'maybe';
  rows?: Record<string, unknown>[];   // insert / upsert
  patch?: Record<string, unknown>;    // update
  returning?: boolean;
  onConflict?: string | null;
}

export interface BuiltQuery { text: string; params: unknown[]; countText?: string; countParams?: unknown[] }

export class QueryError extends Error {}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
export const ident = (s: unknown): string => {
  if (typeof s !== 'string' || !IDENT.test(s)) throw new QueryError('Bad name: ' + String(s).slice(0, 40));
  return s;
};

export const MAX_ROWS = 10000;
const OPS: QueryOp[] = ['select', 'insert', 'upsert', 'update', 'delete'];

/** Postgres array literal ({"a","b"}) for text / uuid / ... array parameters. */
export const pgArray = (v: unknown[]) => '{' + v.map((x) => (x == null ? 'NULL' : '"' + String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"')).join(',') + '}';

/**
 * JS value -> parameter. Arrays always become array literals. Objects: 'json' mode sends JSON text (PGlite, demo);
 * 'raw' mode leaves objects, numbers and booleans as they are, because postgres.js (the Worker) serialises each
 * parameter by the type Postgres reports (JSON.stringify for json/jsonb, 't'/'f' for boolean).
 */
export type ParamMode = 'json' | 'raw';
export function toParam(v: unknown, mode: ParamMode = 'json'): unknown {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) return pgArray(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' && !Number.isFinite(v)) throw new QueryError('Bad number');
  if (mode === 'raw') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

/** Splits a PostgREST or() expression at top-level commas. */
function splitOr(expr: string): string[] {
  const out: string[] = []; let depth = 0, cur = '';
  for (const ch of expr) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function buildQuery(spec: QuerySpec, mode: ParamMode = 'json'): BuiltQuery {
  if (!spec || typeof spec !== 'object') throw new QueryError('Missing query');
  const table = ident(spec.table);
  const op: QueryOp = spec.op ?? 'select';
  if (!OPS.includes(op)) throw new QueryError('Bad operation');
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(toParam(v, mode)); return '$' + params.length; };
  const where: string[] = [];

  for (const f of spec.filters ?? []) {
    const c = ident(f.col);
    switch (f.op) {
      case 'eq': where.push(f.val === null ? `${c} is null` : `${c} = ${p(f.val)}`); break;
      case 'neq': where.push(`${c} is distinct from ${p(f.val)}`); break;
      case 'gt': where.push(`${c} > ${p(f.val)}`); break;
      case 'gte': where.push(`${c} >= ${p(f.val)}`); break;
      case 'lt': where.push(`${c} < ${p(f.val)}`); break;
      case 'lte': where.push(`${c} <= ${p(f.val)}`); break;
      case 'like': where.push(`${c}::text like ${p(f.val)}`); break;
      case 'ilike': where.push(`${c}::text ilike ${p(f.val)}`); break;
      case 'is': where.push(f.val === null ? `${c} is null` : `${c} is ${f.val ? 'true' : 'false'}`); break;
      case 'not_is': where.push(f.val === null ? `${c} is not null` : `${c} is not ${f.val ? 'true' : 'false'}`); break;
      case 'in': {
        if (!Array.isArray(f.val)) throw new QueryError('in() needs a list');
        where.push(`${c}::text = any(${p(f.val.map(String))}::text[])`); break;
      }
      case 'not_in': {
        const list = Array.isArray(f.val) ? f.val.map(String)
          : String(f.val ?? '').replace(/^\(|\)$/g, '').split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        where.push(`not (${c}::text = any(${p(list)}::text[]))`); break;
      }
      case 'not_eq': where.push(`not (${c} = ${p(f.val)})`); break;
      case 'contains': where.push(`${c} @> ${p(f.val)}`); break;
      default: throw new QueryError('Bad filter ' + String((f as Filter).op));
    }
  }
  for (const expr of spec.or ?? []) {
    const parts = splitOr(String(expr)).map((s) => {
      const [col, fop, ...rest] = s.split('.');
      const val = rest.join('.');
      const c = ident(col);
      if (fop === 'ilike') return `${c}::text ilike ${p(val.replace(/\*/g, '%'))}`;
      if (fop === 'eq') return `${c}::text = ${p(val)}`;
      if (fop === 'is' && val === 'null') return `${c} is null`;
      if (fop === 'gte') return `${c} >= ${p(val)}`;
      if (fop === 'lte') return `${c} <= ${p(val)}`;
      if (fop === 'in') return `${c}::text = any(${p(val.replace(/^\(|\)$/g, '').split(','))}::text[])`;
      throw new QueryError('Unsupported or() filter ' + fop);
    });
    if (parts.length) where.push('(' + parts.join(' or ') + ')');
  }
  const w = where.length ? ' where ' + where.join(' and ') : '';

  if (op === 'select') {
    const cols = !spec.cols || spec.cols.trim() === '*' ? '*'
      : spec.cols.split(',').map((c) => c.trim()).filter(Boolean).map(ident).join(', ');
    let text = `select ${cols} from ${table}${w}`;
    const orders = (spec.orders ?? []).map((o) => `${ident(o.col)} ${o.asc === false ? 'desc' : 'asc'}${o.nulls === 'first' ? ' nulls first' : o.nulls === 'last' ? ' nulls last' : ''}`);
    if (orders.length) text += ' order by ' + orders.join(', ');
    const limit = spec.limit == null ? MAX_ROWS : Math.max(0, Math.min(MAX_ROWS, Math.floor(Number(spec.limit))));
    if (!Number.isFinite(limit)) throw new QueryError('Bad limit');
    text += ' limit ' + limit;
    if (spec.offset != null) {
      const off = Math.max(0, Math.floor(Number(spec.offset)));
      if (!Number.isFinite(off)) throw new QueryError('Bad offset');
      text += ' offset ' + off;
    }
    const out: BuiltQuery = { text, params };
    if (spec.count === 'exact') out.countText = `select count(*)::int as n from ${table}${w}`, out.countParams = [...params];
    return out;
  }

  if (op === 'insert' || op === 'upsert') {
    const rows = spec.rows ?? [];
    if (!Array.isArray(rows) || !rows.length) throw new QueryError('Nothing to insert');
    if (rows.length > 500) throw new QueryError('Too many rows in one insert (max 500)');
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))].map(ident);
    if (!cols.length) throw new QueryError('Nothing to insert');
    const values = rows.map((r) => '(' + cols.map((c) => (r[c] === undefined ? 'default' : p(r[c]))).join(', ') + ')').join(', ');
    let text = `insert into ${table} (${cols.join(', ')}) values ${values}`;
    if (op === 'upsert') {
      const conf = String(spec.onConflict || 'id').split(',').map((s) => ident(s.trim()));
      const upd = cols.filter((c) => !conf.includes(c)).map((c) => `${c} = excluded.${c}`);
      text += ` on conflict (${conf.join(', ')}) do ${upd.length ? 'update set ' + upd.join(', ') : 'nothing'}`;
    }
    return { text: text + ' returning *', params };
  }

  if (op === 'update') {
    const patch = spec.patch ?? {};
    const keys = Object.keys(patch);
    if (!keys.length) throw new QueryError('Nothing to update');
    if (!where.length) throw new QueryError('An update needs a filter');
    const sets = keys.map((k) => `${ident(k)} = ${p(patch[k])}`).join(', ');
    return { text: `update ${table} set ${sets}${w} returning *`, params };
  }

  if (!where.length) throw new QueryError('A delete needs a filter');
  return { text: `delete from ${table}${w} returning *`, params };
}

/** Shapes rows like supabase-js did, so screens did not change: single / maybeSingle / head / count. */
export function shape(spec: QuerySpec, rows: Record<string, unknown>[], count: number | null) {
  const op = spec.op ?? 'select';
  let data: unknown = spec.head ? null : rows;
  if (spec.mode === 'single') {
    if (rows.length !== 1) return { data: null, count, error: rows.length ? 'Multiple rows returned' : 'Not found' };
    data = rows[0];
  } else if (spec.mode === 'maybe') data = rows[0] ?? null;
  if (op !== 'select' && !spec.returning && (spec.mode ?? 'many') === 'many') data = null;
  return { data, count, error: null as string | null };
}
