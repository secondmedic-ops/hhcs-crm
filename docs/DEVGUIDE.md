# CareDesk frontend: developer guide

React 18 + Vite, plain JavaScript (JSX). No TypeScript, no CSS framework, no icon library, no chart library.
Read these before writing a page:

- `supabase/migrations/*_caredesk_schema.sql` tables, `*_caredesk_logic.sql` RPCs (business rules), `*_caredesk_rls.sql` who sees what, `*_caredesk_views.sql` read views. `docs/schema.md` lists every column (generated).
- `src/lib/db.js`, `lib/hooks.js`, `lib/fmt.js`, `lib/api.js`, `lib/auth.jsx` (and `src/api.ts`, the only file that calls the Worker)
- `src/components/ui.jsx`, `charts.jsx`, `icons.jsx`, `CallCenter.jsx`
- `src/pages/Dashboard.jsx` is the reference page for structure and style.
- `src/styles.css` for every class that exists. Reuse classes; add new CSS only at the end of styles.css under a comment with your page name, sparingly.

## Data access

```js
import { db, q, rpc, isDemo } from '../lib/db.js';
const rows = await q(db.from('v_cases').select('id,case_no,stage').eq('stage', 'pricing').order('created_at', { ascending: false }).limit(50));
const n = await q(db.from('approvals').select('id', { count: 'exact', head: true }).eq('status', 'pending')); // returns a number
await rpc('advance_case', { p_case: id, p_note: null });   // throws Error(message) on failure
```

- The builder records a query description; the Worker turns it into SQL and runs it as the signed-in user (Row Level Security applies). Reads issued together travel in one request. The same subset works in the browser demo (PGlite): `select(cols, {count, head})`, `insert(rows)`, `update(patch)`, `delete()`, `upsert(rows, {onConflict})`, `eq neq gt gte lt lte like ilike is in contains not(col,'is',null) not(col,'in','(a,b)') or('a.ilike.*x*,b.eq.y') order limit range single maybeSingle`, and `.select()` after insert/update to return rows.
- **Never use embedded relations** (`select('*, patients(*)')`). Use the views: `v_cases v_patients v_calls v_callbacks v_assignments v_escalations v_approvals v_complaints v_audit v_access`. Column lists must be plain identifiers.
- RPC args are passed by name exactly as the SQL function parameter names (`p_case`, `p_note`, `p` ...). jsonb args take plain JS objects.
- Protected case columns (stage, totals, quote_status, payment_status, booking_confirmed_at, quote_sent_at, closed_at...) can only change through RPCs. The Worker allows no plain `update` on cases: the requirement fields (branch, services_requested, additional_info, expected_discharge_on, requested_service_start_on) change through `set_case_requirements`.
- Live updates: `useLoad(fn, deps, ['cases','calls'])` re-runs when those tables change (the Worker's live hub pushes changed table names over a WebSocket; demo uses an in-browser event bus).
- Worker actions (secrets live server side): `import { dial, sendQuote, sendMessage, aiBrief, aiCall, aiCommand, aiExtract, recordingUrl, createUser, webhookEvents, integrations } from '../lib/api.js'`. In demo they are simulated by `demo/sim.js`. Never call `fetch('/api...')` from a screen.
- A table or action a screen needs must be allowed for that role in `cloudflare/src/services/data.ts` (`READ`, `WRITE`, `RPC`); otherwise the Worker answers 403.

## Key RPCs (see 0002_logic.sql for exact behaviour)

| RPC | args | notes |
|---|---|---|
| create_enquiry | p (jsonb: patient{full_name,age,gender,mobile,email,address,landmark,locality,pincode,lat,lng}, caller_name, caller_relation, caller_mobile, source_channel, priority, services_requested, clinical_notes, preferred_slot, expected_discharge_on, requested_service_start_on (dates 'YYYY-MM-DD', optional), consent bool, call_id, service_ids[]) | returns {case_id, case_no, patient_id} |
| set_case_requirements | p_case, p (jsonb: any of branch, services_requested, additional_info, expected_discharge_on, requested_service_start_on; dates 'YYYY-MM-DD') | only the keys sent change (null clears); returns {case_id, expected_discharge_on, requested_service_start_on} |
| case_gates | p_case | {stage, next, ready, checks:[{label, ok}]} |
| advance_case | p_case, p_note | next stage only, gates enforced |
| cancel_case / reopen_case | p_case, p_reason | |
| set_discount | p_case, p_pct, p_reason | above band → approval + quote blocked |
| decide_approval | p_id, p_approve, p_note | client_manager only |
| send_quote | p_case, p_template | prefer `sendQuote()` from api.js (also delivers WhatsApp) |
| render_template | p_template, p_case | text preview |
| confirm_booking | p_case, p_slot, p_coordinator, p_template | |
| assign_staff | p_case, p_staff, p_task (phlebotomy/xray/ecg/visit), p_eta, p_backup_for | coordinator/supervisor |
| field_update | p_assignment, p_action ('en_route','checkin','delay','complete'), p (jsonb: eta, lat, lng, reason, checklist{consent,id_check,procedure}, signoff) | |
| upsert_sample | p (jsonb: case_id, barcode, kind, collected_at, handover_at, dispatched_at, transport_temp_c, received_at, accessioned_at, report_released_at, delivered_at, critical_flag, critical_note) | critical → clinical escalation |
| record_payment | p_case, p_amount, p_mode (upi/link/card/cash), p_txn, p_account (HHC_HINDUJA / HHC_SECONDMEDIC) | Legacy calls without p_account default to HHC_HINDUJA. MIS collections.by_account sums each destination. |
| reconcile_payment | p_payment, p_ok, p_exception | supervisor/coordinator |
| set_report_status | p_case, p_status (pending/released/delivered/na) | |
| capture_feedback | p_case, p_rating, p_text | |
| record_consent | p_patient, p_kind ('verbal'/'digital'), p_call | |
| callback_update | p_id, p_status (pending/in_progress/unreachable); Done requires callback_close(p_id,p_outcome,p_note), p_note | |
| request_rate_change | p_service, p_new_price, p_reason | → approval |
| submit_template | p_template | → approval |
| log_access | p_action ('view_case','view_patient','export','play_recording'), p_entity, p_entity_id, p_meta | call on case/patient open and every export |
| dashboard_kpis | p_from, p_to (ISO) | jsonb |
| mis_report | p_from, p_to (dates 'YYYY-MM-DD') | jsonb |

Direct inserts allowed by RLS: `escalations` (type, level, trigger_text, case_id, workspace_id, raised_by), `complaints`, `interactions` (only channel 'note'/'field' with actor_id = me), `qa_reviews` (supervisor), `callbacks`, `templates` (draft), `zones`, `sla_policies`, `escalation_matrix`. Always set `workspace_id: profile.workspace_id`.

## Auth & roles

`const { profile, workspace, can, isClient, isOps } = useAuth();` Roles: agent, coordinator, supervisor, field_staff, medical_desk, client_manager (Hinduja management), client_clinical (Hinduja clinical), admin (config only, no patient data). Hide controls a role cannot use; RLS enforces it anyway. Export rights: supervisor (logged), client_manager, client_clinical. Agents never see full phone numbers (views mask them); dialling goes through `dial({case_id})`.

## UI rules (non-negotiable)

- Use components from `ui.jsx` (Button, Badge, StageBadge, SlaBadge, Countdown, Panel, PageHead, Kpi, Tabs, Modal, Drawer, Field, Input, Select, Textarea, Check, Segmented, Confirm, Empty, TableSkeleton, Skeleton, AiTag, useToast, useAction) and `Icon` from icons.jsx (add new paths there if needed, 16px stroke style).
- Every data region shows `TableSkeleton`/`Skeleton` while loading and `Empty` when empty.
- No emojis, no gradients, no shadows, no rounded pills beyond 3px radius, no animations on hover, no purple, no em dashes in copy (use a colon, comma or "·"). Use "–" for empty values.
- Dense, operational layout. Tables `className="t"`, numbers/IDs in `.mono`. Times are IST via `fmt.js` helpers (`time`, `dateTime`, `ago`, `inr`, `dur`).
- AI output is always marked with `<AiTag />` and is advisory (a button to apply, never auto-commit).
- Copy is plain and specific to Hinduja Home Care Services (sample collection, portable X-ray, ECG at home, MMR zones).
- Pages must work at 390px wide (field staff use phones).
- Errors: wrap mutations in `const [run, busy] = useAction(); run(() => rpc(...), 'Saved')`, which toasts errors.
- Default export a React component per page file. Do not touch files you were not assigned, except appending to styles.css and icons.jsx.

## Verify

`npm run build` from the repo root must pass. With no Worker running the app opens the in-browser demo; `RUN-LOCAL-TEST.bat` runs it against the real Worker.
