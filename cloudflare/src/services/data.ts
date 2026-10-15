// Screen data: reads, writes and business actions (RPCs), always as the signed-in user (db.asUser), so the
// database's Row Level Security and the role checks inside every RPC apply on top of the rules below.
//   POST /api/v1/batch          several reads in ONE transaction (a screen's loaders, sent together)
//   POST /api/v1/data/{table}   one write (insert / update / upsert / delete) on an allowed table
//   POST /api/v1/rpc/{fn}       one business action (advance a case, approve a discount, record a payment ...)
import type { Ctx } from '../api/context';
import { allows, type Role } from '../api/auth';
import { ApiError } from '../domain/errors';
import { buildQuery, QueryError, shape, type QuerySpec, ident, toParam } from '../domain/query';
import { asUser, readAsUser, type Tx } from '../db';

const ALL: readonly Role[] = ['agent', 'coordinator', 'supervisor', 'field_staff', 'medical_desk', 'client_manager', 'client_clinical', 'admin'];
const OPS: readonly Role[] = ['agent', 'coordinator', 'supervisor', 'medical_desk'];
const MANAGERS: readonly Role[] = ['supervisor', 'client_manager'];
/** Manage the rate card and buying rates (platform admin: configuration only, no case data). */
const RATE_MANAGERS: readonly Role[] = ['supervisor', 'admin'];
/** SecondMedic commercial staff: buying costs and margins of the cases they can see. Not Hinduja, agents, field, medical, partners. */
const COMMERCIAL: readonly Role[] = ['supervisor', 'coordinator'];
const COMMERCIAL_RATES: readonly Role[] = ['supervisor', 'coordinator', 'admin'];
/** ALL staff plus service-provider logins (Book My Medicare): only what a provider needs for its leads. */
const WITH_PROVIDER: readonly Role[] = [...ALL, 'provider'];

/** Who may read a table / view (rows are then filtered by RLS per role). Not listed = nobody. Provider logins may query the
 *  case-page tables; Row Level Security returns them nothing from calls, assignments, payments, approvals, SLA timers, complaints. */
export const READ: Record<string, readonly Role[]> = {
  workspaces: WITH_PROVIDER, zones: WITH_PROVIDER, profiles: WITH_PROVIDER, services: WITH_PROVIDER, templates: WITH_PROVIDER, sla_policies: WITH_PROVIDER, escalation_matrix: WITH_PROVIDER,
  patients: WITH_PROVIDER, cases: WITH_PROVIDER, case_items: WITH_PROVIDER, case_stage_history: WITH_PROVIDER, calls: WITH_PROVIDER, interactions: WITH_PROVIDER, callbacks: WITH_PROVIDER,
  approvals: WITH_PROVIDER, sla_timers: WITH_PROVIDER, complaints: WITH_PROVIDER, escalations: WITH_PROVIDER, assignments: WITH_PROVIDER, samples: WITH_PROVIDER, payments: WITH_PROVIDER,
  qa_reviews: WITH_PROVIDER, notifications: WITH_PROVIDER, inbound_emails: WITH_PROVIDER,
  providers: WITH_PROVIDER, case_referrals: WITH_PROVIDER, v_referrals: WITH_PROVIDER,
  discharge_assessments: ALL, v_assessments: ALL,
  payment_schedule: ALL, v_payment_schedule: ALL, partner_deployments: WITH_PROVIDER, v_deployments: WITH_PROVIDER, case_journey_history: WITH_PROVIDER,
  mis_snapshots: ['supervisor', 'coordinator', 'client_manager', 'client_clinical'],
  audit_log: MANAGERS, access_log: MANAGERS, v_audit: MANAGERS, v_access: MANAGERS,
  // buying rates and imports: SecondMedic rate managers (and coordinators for the buying card); RLS narrows again.
  // Booking costs and margins are not tables here: only case_margins / margin_report return them.
  provider_rates: COMMERCIAL_RATES, rate_imports: RATE_MANAGERS, service_price_history: ALL,
  v_cases: WITH_PROVIDER, v_patients: WITH_PROVIDER, v_calls: WITH_PROVIDER, v_callbacks: WITH_PROVIDER, v_assignments: WITH_PROVIDER, v_escalations: WITH_PROVIDER, v_approvals: WITH_PROVIDER, v_complaints: WITH_PROVIDER, v_whatsapp_chats: WITH_PROVIDER,
};

/** Who may write which table, by operation. Everything else changes only through RPCs (stage gates, pricing ...). */
export const WRITE: Record<string, Partial<Record<'insert' | 'update' | 'upsert' | 'delete', readonly Role[]>>> = {
  case_items: { insert: OPS, delete: OPS },
  complaints: { insert: [...OPS, 'client_manager'], update: ['supervisor', 'coordinator', 'client_manager'] },
  escalations: { insert: [...OPS, 'field_staff', 'client_manager', 'client_clinical', 'provider'], update: ['supervisor', 'coordinator', 'medical_desk', 'client_manager', 'client_clinical'] },
  escalation_matrix: { update: ['admin', 'supervisor', 'client_manager'], insert: ['admin', 'supervisor', 'client_manager'] },
  interactions: { insert: [...OPS, 'field_staff', 'provider'] },
  notifications: { update: WITH_PROVIDER },
  providers: { update: ['admin', 'client_manager'] },
  patients: { update: OPS },
  profiles: { update: WITH_PROVIDER },
  qa_reviews: { insert: ['supervisor'] },
  sla_policies: { update: ['admin', 'supervisor', 'client_manager'], insert: ['admin', 'supervisor', 'client_manager'] },
  templates: { insert: ['admin', 'supervisor'], update: ['admin', 'supervisor'] },
  workspaces: { update: ['admin', 'client_manager'] },
  zones: { insert: ['admin', 'supervisor'], update: ['admin', 'supervisor'], delete: ['admin', 'supervisor'] },
  callbacks: { insert: OPS },
};

/** Business actions and who may call them (each function checks again inside the database). */
export const RPC: Record<string, readonly Role[]> = {
  create_enquiry: OPS, advance_case: OPS, cancel_case: OPS, reopen_case: OPS, set_discount: OPS, confirm_booking: OPS,
  record_consent: OPS, callback_update: OPS, set_my_availability: OPS,
  set_autodial: ['supervisor', 'admin', 'client_manager'], autodial_settings: [...OPS, 'admin', 'client_manager'], capture_feedback: OPS, set_report_status: OPS,
  cleanup_whatsapp_autogen: ['admin', 'supervisor'],
  bmm_settings: ['admin','supervisor'], set_bmm_integration: ['admin','supervisor'],
  assign_staff: ['coordinator', 'supervisor'],
  field_update: ['field_staff', 'coordinator', 'supervisor'],
  upsert_sample: [...OPS, 'field_staff'],
  record_payment: [...OPS, 'field_staff'],
  reconcile_payment: ['supervisor', 'coordinator'],
  decide_approval: ['client_manager', 'client_clinical', 'supervisor', 'coordinator', 'admin'],
  request_rate_change: ['admin', 'supervisor'],
  submit_template: ['admin', 'supervisor'],
  update_referral: ['provider', 'supervisor', 'client_manager', 'coordinator'],
  refer_case: [...OPS, 'client_manager'],
  import_cases: ['supervisor', 'client_manager'],
  set_intake: OPS, set_item_scope: OPS, record_signoff: OPS,
  schedule_validation: ['coordinator', 'supervisor', 'medical_desk'],
  record_validation: ['coordinator', 'supervisor', 'medical_desk', 'field_staff'],
  import_referral_updates: ['provider', 'supervisor', 'client_manager'],
  provider_portal: ['provider','field_staff','supervisor','coordinator','agent','client_manager','client_clinical','medical_desk'],
  accept_provider_lead: ['provider','supervisor','coordinator'],
  plan_provider_job: ['provider','supervisor','coordinator'], update_provider_job: ['provider','field_staff','supervisor','coordinator'],
  log_deployment: ['provider', 'supervisor', 'client_manager'], set_payment_schedule: OPS,
  transition_metrics: ['supervisor', 'coordinator', 'client_manager', 'client_clinical'],
  care_plan_sheet: ['coordinator', 'field_staff', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'],
  case_gates: WITH_PROVIDER, render_template: ALL, log_access: WITH_PROVIDER,
  dashboard_kpis: ALL,
  mis_report: ['supervisor', 'coordinator', 'client_manager', 'client_clinical'],
  rate_import_check: RATE_MANAGERS, submit_rate_import: RATE_MANAGERS, set_provider_rate: RATE_MANAGERS, end_provider_rate: RATE_MANAGERS,
  refresh_case_prices: OPS, set_item_provider: COMMERCIAL, case_margins: COMMERCIAL, margin_report: COMMERCIAL,
};
/** Read-only actions that may ride in a batch. */
export const READ_RPC = new Set(['provider_portal','case_gates', 'render_template', 'dashboard_kpis', 'mis_report', 'autodial_settings', 'transition_metrics', 'care_plan_sheet', 'bmm_settings',
  'rate_import_check', 'case_margins', 'margin_report']);

const allowed = (roles: readonly Role[] | undefined, role: Role | null) => allows(roles, role);
const deny = (what: string) => new ApiError(403, `Your role does not allow ${what}. Ask a supervisor.`);

/** Postgres error -> the message the screen shows (RPCs raise readable business messages). */
export function dbMessage(e: unknown): ApiError | null {
  const pg = e as { code?: string; message?: string };
  if (e instanceof QueryError) return new ApiError(400, e.message);
  if (!pg || typeof pg.code !== 'string') return null;
  if (pg.code === 'P0001') return new ApiError(400, String(pg.message));                                  // raise exception in an RPC
  if (pg.code === '42501') return new ApiError(403, 'Not allowed: ' + String(pg.message).replace(/^new row violates /, ''));
  if (pg.code.startsWith('23')) return new ApiError(409, String(pg.message).includes('duplicate') ? 'That record already exists.' : 'Record conflicts with existing data.');
  if (pg.code === '22P02' || pg.code === '22007' || pg.code === '22008' || pg.code === '22003') return new ApiError(400, 'Invalid value: ' + String(pg.message));
  if (pg.code === '42703' || pg.code === '42P01' || pg.code === '42883') return new ApiError(400, String(pg.message));
  return null;
}
const wrap = (e: unknown): never => { throw dbMessage(e) ?? e; };

async function runSelect(tx: Tx, spec: QuerySpec) {
  const q = buildQuery({ ...spec, op: 'select' }, 'raw');
  const rows = await tx.unsafe(q.text, q.params as never[]);
  const count = q.countText ? Number((await tx.unsafe(q.countText, q.countParams as never[]))[0]?.n ?? 0) : null;
  return shape(spec, rows as unknown as Record<string, unknown>[], count);
}

async function runRpc(tx: Tx, fn: string, args: Record<string, unknown>) {
  const keys = Object.keys(args ?? {});
  const text = `select ${ident(fn)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')}) as r`;
  // a list of objects (e.g. import_cases rows) is a jsonb argument; plain lists stay Postgres arrays (text[] / uuid[])
  const param = (v: unknown) => (Array.isArray(v) && v.some((x) => x !== null && typeof x === 'object') ? tx.json(v as never) : toParam(v, 'raw'));
  const [row] = await tx.unsafe(text, keys.map((k) => param(args[k])) as never[]);
  return row?.r ?? null;
}

export interface BatchOp { kind?: 'select' | 'rpc'; spec?: QuerySpec; fn?: string; args?: Record<string, unknown> }

/** Several reads in one transaction. A failed read fails only itself (the batch is retried one by one). */
export async function batch(c: Ctx, body: { ops?: BatchOp[] }) {
  const ops = Array.isArray(body?.ops) ? body.ops : [];
  if (!ops.length) return { results: [] };
  if (ops.length > 40) throw new ApiError(400, 'Too many reads in one batch (max 40)');
  for (const op of ops) {
    if (op.kind === 'rpc') {
      if (!op.fn || !READ_RPC.has(op.fn) || !allowed(RPC[op.fn], c.user.role)) throw deny(`"${op.fn}"`);
    } else {
      const t = op.spec?.table;
      if (!t || !allowed(READ[t], c.user.role)) throw deny(`reading "${t}"`);
      if (op.spec && op.spec.op && op.spec.op !== 'select') throw new ApiError(400, 'Only reads can be batched');
    }
  }
  const run = (tx: Tx, op: BatchOp) => (op.kind === 'rpc' ? runRpc(tx, op.fn!, op.args ?? {}).then((data) => ({ data, count: null, error: null })) : runSelect(tx, op.spec!));
  try {
    const results = await readAsUser(c.sql, c.user.id, async (tx) => {
      const out = [];
      for (const op of ops) out.push(await run(tx, op));
      return out;
    });
    return { results };
  } catch {
    // one bad read aborted the transaction: answer each read on its own, so the others still show
    const results = [];
    for (const op of ops) {
      try { results.push(await readAsUser(c.sql, c.user.id, (tx) => run(tx, op))); }
      catch (e) { results.push({ data: null, count: null, error: (dbMessage(e) ?? new ApiError(500, 'Could not load')).message }); }
    }
    return { results };
  }
}

/** One write. Returns the shaped result and the changed tables (for live updates). */
export async function write(c: Ctx, table: string, spec: QuerySpec) {
  const op = spec?.op;
  if (!op || op === 'select') {
    if (!allowed(READ[table], c.user.role)) throw deny(`reading "${table}"`);
    const r = await readAsUser(c.sql, c.user.id, (tx) => runSelect(tx, { ...spec, table })).catch(wrap);
    return { body: r, changed: [] as string[] };
  }
  if (!allowed(WRITE[table]?.[op], c.user.role)) throw deny(`changing "${table}"`);
  const q = buildQuery({ ...spec, table }, 'raw');
  const { result, changed } = await asUser(c.sql, c.user.id, async (tx) => tx.unsafe(q.text, q.params as never[])).catch(wrap);
  return { body: shape({ ...spec, table }, result as unknown as Record<string, unknown>[], null), changed };
}

export async function rpc(c: Ctx, fn: string, args: Record<string, unknown>) {
  if (!allowed(RPC[fn], c.user.role)) throw deny(`"${fn}"`);
  if (READ_RPC.has(fn)) return { body: { data: await readAsUser(c.sql, c.user.id, (tx) => runRpc(tx, fn, args ?? {})).catch(wrap) }, changed: [] as string[] };
  const { result, changed } = await asUser(c.sql, c.user.id, (tx) => runRpc(tx, fn, args ?? {})).catch(wrap);
  return { body: { data: result }, changed };
}
