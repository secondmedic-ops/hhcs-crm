# Book My Medicare connection: functional logic and implementation plan

> **Not pursued (20 October 2026).** BMM works directly in the CareDesk portal ([PROVIDER-FULFILMENT.md](PROVIDER-FULFILMENT.md)), with SecondMedic giving them support. This API stays disabled and is kept only as reference.

**Design date:** 15 October 2026. **Release status:** deployment/publication authorized by the user on 15 October 2026. **Scope:** this document specifies proposed logic. Publishing it does not implement the proposed extensions or activate BMM patient exchange.

**Authorization update:** after reviewing the design, the user instructed, "Please Push to deploy." This lifts the earlier commit/push/deployment hold for publishing the HHCS-side preparation and this design. BMM interface documentation, implementation of the proposed controls, sandbox acceptance, credentials and explicit activation remain prerequisites for actual exchange. The historical investigation and phased plan below retain the original design-stage findings; references to the earlier deployment hold are superseded by this update for publication. The release is isolated from unrelated working-tree changes.

**Publication validation:** the isolated release based on `3af8698d342ab63362858ac04c86e07c33743f3c` passed backend and frontend TypeScript checks, all 43 existing tests in 9 files, the disposable Worker rehearsal with 308 API checks, frontend production build, API contract check and deployment lint. It excludes the concurrent WhatsApp/closure/catalogue work described in the historical findings. These checks validate publication against the existing application; they do not implement or verify this document's proposed BMM extensions, BMM sandbox compatibility or live exchange.

**Implementation update (15 October 2026, later):** `20261015170200_bmm_release_scope.sql` makes `bmm_leads()` honour the provider chosen on each case line (`case_item_costs.provider_id`) before category routing, and return the agreed case-line unit instead of the current rate-card unit. BMM's categories include the catch-all `other` since `20261015140000`, so explicit item assignment (section 11) remains a prerequisite before activation. The closure-gate migrations referred to below as `20261015122000` / `20261015123000` were renumbered `20261015170000` / `20261015170100` so they apply after production's latest migration; the focused BMM tests now pass on that tree.

This is a proposed HHCS design grounded in the inspected repository. It is not BMM's API specification or evidence of a working connection. BMM documentation remains the dependency for selecting and implementing the actual transport. The existing [HHCS-side contract](BMM-INTEGRATION.md) describes the prepared first slice. The [information request](BMM-INFORMATION-REQUEST.md) is a draft for internal review, not a message sent to BMM.

## 1. Evidence and current implementation

### Repository state verified during this review

- Local `main`, local `origin/main`, and GitHub's read-only `commits/main` response identify `009aedc500bdea0450d8c688a8700db75810927b`.
- BMM files are tracked and committed. The most recent commit touching `cloudflare/src/services/bmm.ts` is `a2b2f3c36e342e812becb6edd2aa0abdbd32d3e2`, an ancestor of current HEAD. They are not an uncommitted BMM draft.
- GitHub reports [ship run 38694620359](https://github.com/secondmedic-ops/hhcs-crm/actions/runs/38694620359) completed successfully for current HEAD at 06:50:51 UTC / 12:20:51 IST on 15 October 2026. The inspected workflow applies migrations, deploys, smokes and records. This is historical deployment evidence for source containing the BMM preparation. This review did not trigger that run, query production settings, inspect production schema, or establish live BMM activation or data exchange.
- Pre-existing working-tree changes: `cloudflare/test/workflow.test.mjs`, `src/pages/CaseDetail.jsx`, `src/pages/Transition.jsx`; untracked `src/components/WhatsAppChat.jsx` and `supabase/migrations/20261015123000_case1_communication_templates.sql`. They were preserved. Findings below describe the inspected files, including that working-tree state.
- During the review, additional concurrent edits appeared in `cloudflare/src/services/data.ts` and `src/pages/Escalations.jsx`, with new `supabase/migrations/20261015122000_closure_gate_hardening.sql`. These are not changes made by this task. The new migration was inspected for overlap: it hardens manual closure stage gates and adds operational/billing escalations, but does not replace `update_referral()`'s external-only automatic closure branch or implement revision/resource obligations. Coordinate the later BMM implementation with this ongoing work instead of duplicating or overwriting it.
- Executed only the existing focused BMM tests: `npx --no-install vitest run test/bmm.test.ts` in `cloudflare/`, against disposable PGlite with repository migrations. The first run passed both tests. A second run after the concurrent closure migration appeared passed validation but failed database setup with `cannot change name of view column "case_no" to "resolution_notes"`. The new migration adds `escalations.resolution_notes`, then replaces `v_escalations` using `e.*`, which moves the existing projected `case_no` position. Coordinate a compatible view projection repair in that ongoing work before treating the current working tree as test-passing. This task did not edit that migration. No production database was used, and no new functionality is proven by either run.
- GitHub connector calls were unavailable (`Unknown tool`); read-only GitHub CLI calls supplied the remote evidence. No remote mutation was performed.

### Inspected behavior and gaps

| Area and source | Confirmed implementation | Consequence for the complete connection |
|---|---|---|
| `PROJECT.md`, `CLAUDE.md`, `AGENTS.md` | One Worker, Supabase/Postgres, JWT plus `caredesk_app`/RLS; system work uses `asSystem`; administrator inherits specified senior permissions | Preserve this boundary and pipeline; no new platform or paid service |
| `cloudflare/src/api/routes.ts`, `src/api.ts`, generated `docs/openapi.json` | Provider-only `GET /api/v1/bmm/leads`, `POST /api/v1/bmm/leads/{id}/status`; browser client wrappers exist | Reuse paths and auth if BMM accepts them; version extended contract explicitly |
| `cloudflare/src/services/bmm.ts` | Pagination validation, UUID event IDs, status validation, note bound, timezone requirement, `deployed` alias | Extend validation with revision, external references, resource events and byte limits |
| `20261014100000_bmm_partner_api.sql` | Settings disabled by default, contract-confirmation gate, active BMM provider/login checks, role/workspace scoping; status event transaction with payload conflict detection and referral lock | Reuse; current settings have no sandbox identity, actual connection test or exchange health |
| `bmm_leads()` | Offset snapshot, max page 100, ID-only hold/cancel records; includes name/mobile/address, branch/hospital, dates, BMM-category included items; excludes prices, recordings and assessment records | No durable cursor, receipt acknowledgement, external order ID, consent-purpose grant, plan revision or resource contract |
| Item selection in `bmm_leads()` | `not i.excluded AND i.category = ANY(pv.categories)`; unit from current `services.unit` | Category eligibility is not explicit assignment. Use assigned item links and agreed `case_items.unit`, never mutable catalogue units |
| Provider identity | Machine API currently reuses an ordinary provider login | That login can also reach generic provider batch/RPC/portal surfaces. `v_referrals` includes `clinical_notes`; API minimization alone does not constrain the identity. Add an integration-only identity restriction before machine credentials are issued |
| `route_case()` in `20261013150000_discharge_transition.sql` | Category/text routing; post-discharge waits for sign-off; auto-cancels obsolete referrals only while new; creates provider SLA and timeline | Keep routing for discovery. It does not publish a revisioned external order, settle accepted amendments or prove transfer |
| `record_signoff()`, `recalc_case()` in that migration | Quote/validation checks; sign-off evidence; total change clears sign-off | Equal-total service substitutions, dates, address and coverage changes also need revision invalidation; commercial sign-off alone is not authorization for every data category |
| `bmm_apply_status()` | Atomic dedupe, expected-status conflict, forward graph, hold check, delegates to `update_referral()` | Good first slice. No BMM external reference, event occurrence time, revision or resource identity |
| `update_referral()` in that migration | Broader than API graph; portal/Excel can skip stages. Fills several inferred timestamps, writes timeline/SLA/notifications. External-only case closes when no live referrals remain, at least one completed, no active SM referral | Put eligibility, transition, timestamp, resource and closure guards in shared SQL. API-only guards can be bypassed by portal/Excel |
| Concurrent `20261015122000_closure_gate_hardening.sql` | Adds completion/referral/payment/dispatch checks in `case_gates()` and an `advance_stage()` alias; not committed at inspection | Integrate with those gates later; they do not by themselves govern the separate automatic provider-only closure branch |
| `log_deployment()` in `20261013170000_discharge_data_model.sql` | Staff/equipment per referral; optional item; dispatch/delivery/install/active/return/cancel; first deployment moves lead; infers some timestamps | Reuse physical resource records, add stable external identity and occurrence linkage; first resource progress must be labelled partial and must not satisfy all-resource SLA or closure |
| Existing visibility | Latest `can_see_case()` in discharge-transition migration retains access for named coordinator or assessment nurse on BMM-only cases | Require a responsible named coordinator; preserve that narrow access instead of giving every coordinator all partner cases |
| `Leads.jsx`, `CaseDetail.jsx`, `Transition.jsx` | Lead actions, provider panels, work orders, Excel status sync | Extend existing views, not a second CRM. Current configuration text overstates sign-off protection: API sign-off hold currently applies specifically to post-discharge cases |
| `case_item_costs`, `set_item_provider()` in `20261015130000_buying_rates_margins.sql` | Selected buying provider is commercial/cost data, supervisor-only amendment after agreement | Use selection as a proposed assignment default for review, not an automatic external routing instruction; never expose the cost row |
| `cloudflare/test/bmm.test.ts`, `api.itest.mjs`, `workflow.test.mjs` | Existing validation/isolation/hold/dedupe/status/closure tests and rehearsal checks | Useful regression base; no vendor sandbox, reliable cursor/outbox or complete fulfilment proof |

Generated `docs/schema.md` and `docs/openapi.json`, the discharge SOP/data dictionary, `docs/DEVGUIDE.md`, Worker routing/body handling, `db.ts`, `services/data.ts`, `services/cron.ts`, `scripts/ship.mjs` and `.github/workflows/ship.yml` were also inspected. Generated files must later be regenerated, not edited as handwritten specifications.

### Fact, proposal and dependency boundary

**Confirmed:** HHCS has the above lead API and provider workflow, with no outbound BMM adapter in the inspected service. **Proposed:** everything below that adds fields, endpoints, tables, timing defaults or workflows. **Unresolved:** BMM product, actual URLs/auth, field/status names, idempotency, webhooks, sandbox, limits, cancellation/amendment semantics and onboarding. An unknown BMM field is marked `TBD` rather than assigned a fictional name.

## 2. Decisions and recommended architecture

No final capability-based connection choice is possible until BMM supplies documentation. The provisional primary candidate is **BMM retrieves HHCS-approved orders and posts acknowledgements and progress**, because it reuses the authenticated API and requires no HHCS outbound vendor infrastructure. Select it only after BMM demonstrates server-side Supabase-token handling, durable cursor consumption, revision acknowledgement, external-reference return, resource updates and hold/cancel handling in a sandbox.

| Candidate | Select when documentation proves | Reuse and required addition |
|---|---|---|
| BMM pulls HHCS and posts updates | BMM can implement our agreed interface | Reuse JWT/BMM provider checks and endpoints; add durable change feed, ack, revisions, resource contract and reconciliation |
| HHCS pushes; BMM sends webhooks | BMM requires its create/update/cancel API and documents authenticated callbacks | Reuse approved plan projection, workflow and event application; add BMM-specific durable outbox, actual auth adapter, raw-body webhook verifier |
| HHCS pushes; HHCS polls BMM | Documented create/read/amend/cancel endpoints exist, callbacks do not | Same outbox; bounded cursor/paged progress polling persisted in Postgres, with actual vendor limits |
| Agreed file exchange | No usable supported API | Versioned file manifest, secure agreed channel, receipt/status import and operator reconciliation. This is a file workflow, not completed direct API integration |

Implement one supported transport after selection. Do not build all four or a generic connector framework. Reuse the existing minute cron and LiveHub; persist every obligation in Postgres. No in-memory queue, paid queue, new broker or separate integration service is needed. Capacity and vendor limits must be measured before release; this design makes no claim that unlimited traffic fits free plans.

Decisions requiring internal/BMM agreement: catalog/unit mapping; meaning of quantity per service; current and future shift/rental obligations; authorized data purpose and minimum fields; acceptance/deployment response targets; allowed partial acceptance; cancellation/stop acknowledgement; vendor idempotency and uncertainty lookup; transport and version; ownership during fallback. Keep `contract_confirmed=false` until the applicable decisions have documentary evidence.

## 3. Business invariants and ownership

1. A referral is the relationship between case and provider. An integration order is one external-order generation for that referral. A plan revision is an immutable agreed version of that order. Individual requirements and deployments are separate from lead status.
2. SecondMedic remains the operational point of contact. Require `cases.coordinator_id`, a same-workspace active coordinator, before release; notify that user, owner when appropriate, and supervisor of acknowledgements, meaningful progress and exceptions. Never expose vendor credentials through notifications.
3. For BMM exchange, commercial approval and applicable assessment must be complete for the released scope, even where existing non-post-discharge routing created an earlier referral. All required sign-off is bound to the current material plan revision.
4. Record a scoped sharing authorization/purpose decision with recipient BMM, permitted data categories, evidence reference, version, recorder and revocation time. Reuse consent evidence where it explicitly covers this purpose; do not infer it from `signoff_at` or generic consent timestamps. No new legal conclusion is asserted here. Unresolved authorization blocks release.
5. Only explicitly BMM-assigned, included, approved items are released. Text-only/category-only referrals remain internal until enumerated and assigned. Reject ambiguous quantities/units/coverage instead of guessing.
6. Lock current case/referral/order and recheck eligibility on every publication, fetch serialization, delivery attempt, acknowledgement and new fulfilment update. Deduplicated historical success can be reported without repeating a mutation. Safety/cessation evidence remains receivable while fulfilment is on hold.
7. Never infer every item's arrival from one resource, infer receipt from HTTP GET, or infer vendor cancellation from local cancellation. Separate `delivery_state`, `partner_status`, `control_state` and per-resource state.
8. No integration event grants permission to cancel/reopen a case or referral. Existing role restrictions remain; administrator inheritance must match backend and frontend rules.
9. Cancellation, withdrawal, unresolved mapping or unknown outcome blocks new fulfilment and automatic closure. Already-occurring care is escalated to the coordinator/medical desk for a safe transition; the software must not assume an abrupt unattended clinical stop is safe.

**Material plan fingerprint:** assigned item IDs, inclusion, quantities, agreed units, shift/visit coverage, rental period, agreed dates/address/contact needed for delivery, applicable commercial agreement reference, sharing scope and recipient. Any material change increments revision and invalidates affected approval. Internal notes and cost/margin changes alone do not create a patient-scope revision. Re-selecting a buying provider does not reassign fulfilment without an explicit operational action.

Eligibility is true only if workspace/provider/account are active and correctly bound; selected environment is enabled; contract/version/mapping are verified; order is current; case is neither closed nor cancelled; approved item set is nonempty and all mappings valid; assessment/sign-off requirements and sharing authorization are current; coordinator/contact/address/schedule requirements are valid; no hold, unresolved prior-order withdrawal or pending incompatible amendment exists. Zero-item releases produce a withdrawal for a previously shared order, never a new empty order.

## 4. End-to-end sequence

```mermaid
sequenceDiagram
    participant F as Family
    participant C as SecondMedic coordinator
    participant H as HHCS Worker and Postgres
    participant B as BMM system
    participant S as Supervisor
    C->>H: Record enquiry, consent, assessment and recommended items
    F->>C: Agree scope and commercials; confirm permitted sharing
    C->>H: Record current agreement, assignment, coverage and recipient scope
    H->>H: One transaction: validate, create revision and change record
    B->>H: GET change page with durable cursor
    H->>H: Recheck current eligibility; minimize or return hold/cancel control
    H-->>B: Order/referral IDs, revision, plan or control, next cursor
    B->>B: Persist receipt; create/link one local order by HHCS correlation
    B->>H: ACK receipt + BMM reference + exact revision/event ID
    H-->>C: Receipt visible; acceptance still pending
    B->>H: Accept/decline current revision
    H->>H: Dedupe, validate workflow, timeline, SLA, notifications
    H-->>C: Acceptance or exception
    H-->>S: Exception requiring oversight
    B->>H: Schedule requirements; dispatch individual resources
    B->>H: Arrival/install/start events per resource and occurrence
    H-->>C: Partial progress and outstanding requirement counts
    B->>H: Completion evidence for all required occurrences/resources
    H->>H: Reconcile quantities, time coverage, revision and external status
    H->>H: Apply existing closure rule with new completion guards
    alt Material amendment or sharing/sign-off withdrawal
        C->>H: Change or withdraw plan
        H->>H: Increment revision; hold fulfilment; publish stop/amend control
        B->>H: Retrieve control and acknowledge stopped/amended scope
        H-->>C: Unresolved work and stop acknowledgement
        C->>H: Reapprove current plan or resolve cancellation
    end
```

For push, replace the GET/receipt section with transactionally created outbox work, a claimed delivery, BMM's documented response, and a persisted acknowledgement/uncertainty state. Subsequent business rules are identical. A network call never belongs inside the SQL business transaction.

## 5. Rules for each business step

All evidence below is patient-domain data under RLS where necessary. Audit/access logs contain IDs, actions, revisions, outcome codes and counts, never clinical text or patient payloads. Notify through existing `notify_user`/`notify_role`, timeline and LiveHub after committed changes; repeated events do not duplicate notifications.

| Step / trigger | Validation | System action and evidence | Notification and failure behavior |
|---|---|---|---|
| 1. Enquiry captured | Existing enquiry/consent gates, workspace, contact, branch; internal service descriptions allowed | `create_enquiry`/`set_intake`; keep case/referral IDs; no external transfer | Owner follows intake gaps; incomplete identity/consent remains internal |
| 2. Hospital/home assessment completed | Authorized clinical/assessment role, latest assessment mode; post-discharge validation done | Existing assessment actions and recommended/included/dropped items; internal assessment stays internal | Assigned coordinator/medical desk handle unresolved recommendations; failed validation prevents relevant release |
| 3. Family agrees | SQL prices/discount approvals valid; included items enumerated; current coverage/dates; evidence of decision-maker | `record_signoff` plus new revision-bound approval and recipient sharing scope; retain agreement evidence internally | Coordinator sees missing prerequisites; reject stale approval; never export raw assessment or sign-off notes |
| 4. Approved BMM scope eligible | Full eligibility predicate; explicit assignment/mapping; valid minimum delivery details | Shared SQL release action makes immutable revision and durable feed entry or outbox row in same transaction; content digest | Coordinator sees Ready/On hold with reason. No ready badge or queued work if transaction rolls back |
| 5. Sent or retrieved | Recheck current revision, account, controls and sharing immediately before response/network attempt | Pull: record disclosure metadata; BMM persists correlation before creating local order. Push: record attempt before call, save outcome afterward | Show Awaiting receipt, not Accepted. Suppress superseded work; ambiguous delivery becomes Unknown outcome |
| 6. Receipt acknowledged | Authenticated BMM, same order/revision, valid unique reference; referenced delivery exists; same event/body idempotent | Persist `received_at`, BMM reference and acknowledged revision separately from acceptance; ack cannot activate stale scope | Coordinator notified once. Ref mismatch/duplicate external order opens reconciliation; ack loss retried idempotently |
| 7. Accept/decline | Current acknowledged revision; expected status/version; reason on decline; no hold | `update_referral` through shared event action; preserve real event time; partial scope acceptance requires proposed amendment, not silent removal | Coordinator, owner and supervisor receive decline; unmet requirement remains open/reassignment task; acceptance SLA is not a transport receipt SLA |
| 8. Schedule | Every requirement has agreed occurrence/window, timezone and quantity/coverage; no overlapping conflicting staff assignment | Save requirement schedule and references; lead Scheduled only when all currently due requirements scheduled; partial count otherwise | Coordinator sees unscheduled requirements and ETA gaps; missing dates/conflicts reject the offending event |
| 9. Dispatch | Accepted/current authorized scope, mapped item and occurrence; unique resource ID and staff/equipment type; no stop pending | `log_deployment` extension records specific dispatch; partial lead dispatch permitted and labelled; outbox/feed confirms applied event | Coordinator gets dispatch/counts. Duplicate creates no extra resource; unknown item/provider rejected |
| 10. Arrival/install/duty start | Correct resource/occurrence and valid transition; actual timestamps; equipment serial where required; staff delivery/install labels invalid | Record arrived/delivered, installed, active independently; no fabricated missing timestamps; one active nurse means partial deployment | Coordinator sees gaps. Resource SLA per required start remains running until required coverage is met; unsafe gap escalates via existing matrix |
| 11. Progress/complete | Current scope; every planned occurrence/quantity/coverage accounted for; required return/collection if in scope; no unresolved exception | Progress notes under scope; actual completion per requirement/resource; shared completion gate then lead Completed | Notify coordinator/owner on completion; early aggregate completion held as conflict with list/count of unmet work |
| 12. Exceptions/amend/cancel | Caller authority; latest revision; actual vendor state; dispatch/clinical dependencies | Append amendment/withdrawal revision and explicit stop/cancel request; evidence includes affected items, ack and resolution | Coordinator/supervisor notified immediately; medical desk for care continuity. Pending/unknown cancellation stays actionable; no automatic resumed fulfilment |
| 13. Reconcile/close | Order reference/revision/status, all included obligations, cancellations/declines resolved, no Unknown outcome/hold; existing SM gates | Reconciliation result then `update_referral`/existing case gates with added guards; preserve stage history and existing SQL closure authority | BMM-only closes under existing external-only rule only after guards; mixed case stays on SM journey/gates; mismatch opens coordinator task instead of force-closing |

### Lead versus resource completion

Keep stored lead states unchanged. Lead `in_progress` may mean some work has started; display `1 of 3 required resources active` alongside it. Proposed due-now deployment readiness is computed from all requirements due by the agreed start window, including staff quantity and required coverage, not a count of arbitrary deployment rows. Replacements reference the prior assignment and cannot be double-counted over the same time interval. Future shifts stay scheduled/open; they do not make day one deployment overdue, and they prevent final service completion until delivered or explicitly removed by approved amendment.

For example, two nurses plus a bed require two distinct appropriate staff slots and one equipment obligation. One nurse on duty leaves one staff slot and the equipment unmet. A 12-hour shift covers its explicit interval; it cannot satisfy a 24-hour requirement. Repeated visits count completed occurrences, not daily status messages. Rental completion and equipment return are separate: require return only if the agreed requirement includes collection/return. Do not multiply `qty * plan_days` unless that service's approved quantity basis explicitly requires it.

## 6. Field mapping and proposed HHCS contract

`H→B` is HHCS to BMM; `B→H` is BMM to HHCS. `R` required, `C` conditional, `O` optional. All BMM fields are **TBD pending documentation**. Proposed wire names below are HHCS proposal names only. Source `new` means a schema addition, not an existing field. Null/absence and clear-field semantics must be agreed; do not interpret a missing update field as deletion.

| HHCS source / proposed wire field | Meaning | BMM field | Direction | Need | Transformation / validation | Source authority |
|---|---|---|---|---|---|---|
| `workspaces.id` / `workspace_id` | Tenant correlation | TBD | H→B | R | UUID; server-derived, never trusted from caller | Auth + workspace |
| `providers.id/code` / `provider_id` | BMM recipient | TBD | H→B | R | Active code BMM, same tenant; response identity pinned to connection | Provider config |
| `cases.id`, `case_no` / same | Stable case ID, display reference | TBD | H→B | R | UUID key; display number never cross-tenant lookup key | Case |
| `case_referrals.id` / `referral_id` | Existing provider lead | TBD | Both | R | UUID; belongs to case/provider/workspace | Referral |
| new `bmm_orders.id`, `generation` / `order_id`, `generation` | One external order generation; reopen does not silently reuse cancelled order | TBD | Both | R | Stable UUID and positive generation; unique active generation | Shared release action |
| new `external_order_ref` | BMM's actual reference | TBD | B→H | R at ack | Bounded opaque string; unique per connection; retain exact case; never silently replace | BMM receipt |
| existing/new event `event_id` | Retry-safe action identity | TBD | Both | R | UUID in HHCS contract; external opaque IDs stored separately if vendor differs | Event producer |
| new `revision`, `expected_revision` | Immutable plan/control version and concurrency | TBD | Both | R | Positive monotonic integer per order, exact match; body digest for duplicates | HHCS order |
| new `sequence`, `next_cursor` | Reliable pull position | TBD | H→B | R for pull | Scoped opaque cursor over committed change sequence; no client SQL/offset inference | Feed |
| `case_items.id`, `service_id/code` | Stable line and catalogue mapping | TBD | H→B | R | UUID item; explicit referral assignment; approved service-map version | Agreed plan + service mapping |
| new `case_referral_items` / `items[]` | Only BMM-assigned included services | TBD | H→B | R | Nonempty for release; exclude dropped/other-provider items, reject unmapped lines | Coordinator assignment |
| `case_items.service_name` | Agreed item label | TBD | H→B | R | Bounded text snapshot; catalogue label is not an identifier | Case line snapshot |
| `case_items.qty` / `quantity` | Agreed quantity | TBD | H→B | R | Positive integer under existing schema; service map defines basis; no unagreed fractional conversion | Agreed case line |
| `case_items.unit` / `unit` | Agreed price/fulfilment unit | TBD | H→B | R | Snapshot unit, exact approved conversion; legacy missing unit blocks release | Case line snapshot |
| new `coverage_hours`, `quantity_basis`, `requirements[]` | 12/24 h, concurrent resources versus visits versus rental units | TBD | H→B | C by service | Explicit enumerated basis and valid hours/intervals; not parsed from free text | Approved requirement plan |
| `cases.plan_days`, new `rental_start/end` | Plan duration and actual rental interval | TBD | H→B | C | Positive duration; explicit end-exclusive interval; dates alone cannot imply billing/coverage basis | Agreed plan |
| `cases.expected_discharge_on`, new required windows | Discharge context and agreed fulfilment dates | TBD | H→B | C | Date stays `YYYY-MM-DD`; ISO timestamps require offset; actual order schedule distinct from discharge estimate | Coordinator/family agreement |
| `patients.full_name` / `patient.name` | Identify recipient for delivery | TBD | H→B | R | Minimum display name agreed; no MRN unless separately justified | Patient |
| approved `patients.mobile` or designated contact / `contact` | Reach authorized fulfilment contact | TBD | H→B | R | Valid normalized phone, role/name only when needed; use approved decision-maker rather than exporting every alternate number | Authorized delivery contact |
| `cases.address/pincode` fallback approved patient address / `delivery_address` | Current service destination | TBD | H→B | R | Confirmed deliverable address; Indian PIN validated when applicable; approved landmark only if needed | Current agreed case address |
| `cases.branch`, optional `hospital_name` | Operational routing context | TBD | H→B | C | Allowlist branch; hospital only if needed for agreed handover; no ward/clinical record by default | Workspace/case |
| new approved fulfilment instruction | Minimum practical requirement | TBD | H→B | O | Dedicated reviewed field, not raw `clinical_notes`, `additional_info` or assessment export | Coordinator-approved disclosure |
| `partner_deployments.id`, new external resource/assignment ref | Stable physical assignment | TBD | Both | R for resource updates | Same order/item/occurrence; immutable identity, unique external assignment per connection/order | BMM assignment + HHCS mapping |
| new requirement ID/occurrence, `case_item_id` | Which quantity/shift/visit is fulfilled | TBD | Both | R | Item belongs to active revision; occurrence valid; replacement chain explicit | HHCS requirement plan |
| `staff_ref/name`, `shift`, equipment model/serial | Fulfilment identity | TBD | B→H | C by type | Minimum necessary staff identity, no staff personal phone by default; serial required for delivered equipment | BMM resource data |
| deployment timestamps + new `arrived_at`, `completed_at` | Actual physical events | TBD | B→H | C by action | Timezone-bearing ISO input, UTC storage; record occurred/received separately; logical chronology; no synthetic intermediate times | BMM actual event |
| referral `last_note`, `decline_reason`; new event reason | Progress and exception explanation | TBD | B→H | O / R for decline | Trim, max 2,000 characters, reject unexpected structures; sensitive notes only in protected timeline | BMM scoped event |
| new stop/cancel request + acknowledgement refs | Requested versus confirmed cessation | TBD | Both | R when withdrawal | Exact revision, affected scope, outcome, occurred time; ack never authorizes reopening | Authorized HHCS action + BMM response |
| new `occurred_at`, `received_at`, `acknowledged_at`, `last_reconciled_at` | Source time versus sync evidence | TBD | Both | R as applicable | Server received timestamps trusted; source clock skew flagged; IST display | Producer/HHCS clock |
| existing sign-off and new sharing grant IDs/digest | Eligibility evidence | TBD only if needed | Internal; optional H→B reference | R internally | Send only agreement/reference if required; never raw consent recording or signatures by default | Authorized staff evidence |
| selling commercials | Family agreement | TBD | Internal by default | C only if contract needs | Separate approved minimal commercial field contract, SQL numeric/decimal strings; omit all cost/margin fields | SQL agreement |

Always exclude dropped items, SM-only items, call/recording links, full internal clinical assessments, raw clinical/free-text history, procurement costs, provider rates, margins, internal staff-workspace context, and unrelated patient/case records. Age/gender, attachments, clinical instructions or extra contacts require a demonstrated fulfilment need and approved sharing scope; they are not automatic additions.

### Proposed release envelope, not BMM's actual payload

This illustrative schema uses type placeholders, contains no real patient, and is not executable production input. Actual BMM names are unresolved.

```json
{
  "contract_version": "hhcs-bmm-proposed-v2",
  "workspace_id": "<uuid>",
  "provider_id": "<uuid>",
  "case_id": "<uuid>",
  "case_no": "<display reference>",
  "referral_id": "<uuid>",
  "order_id": "<uuid>",
  "generation": 1,
  "revision": 3,
  "kind": "release",
  "published_at": "<ISO timestamp with timezone>",
  "contact": { "name": "<approved name>", "phone": "<approved phone>" },
  "patient": { "name": "<minimum approved display name>" },
  "delivery_address": { "text": "<approved destination>", "pincode": "<validated PIN>" },
  "items": [{
    "case_item_id": "<uuid>", "service_code": "<mapped HHCS code>",
    "quantity": 2, "unit": "<agreed snapshot unit>",
    "quantity_basis": "<approved basis>",
    "requirements": [{ "id": "<uuid>", "required_quantity": 2,
      "coverage_hours": 12, "starts_at": "<ISO timestamp>", "ends_at": "<ISO timestamp>" }]
  }]
}
```

Proposed receipt: `{event_id, order_id, revision, external_order_ref, received_at}`. Proposed status: existing status body plus `{order_id, revision, occurred_at, external_order_ref}`. Proposed resource event: `{event_id, order_id, revision, case_item_id, requirement_id, external_assignment_ref, expected_resource_version, action, occurred_at, resource:{...}}`. Every actual message also passes connection-derived tenant/provider checks. A receipt means persisted/linked by BMM, not accepted for service.

For the proposed contract, `received_at` supplied by BMM means its durable receipt time; HHCS independently sets its own server receipt time. References are opaque strings, proposed maximum 200 characters; HHCS UUIDs must be valid UUIDs. Required numeric values must be finite integers within approved service bounds, not numeric strings or coerced nulls. Reject unsupported fields on event command bodies so a misspelled revision or action cannot be silently ignored. The final limits and optional fields require BMM agreement.

For holds/cancellations return only correlation IDs, revision, control action/reason code, timestamp and acknowledgement requirements. No patient fields, service narrative or raw withdrawal reason. BMM must process control messages even when it must stop reading full plans. A stale release entry is serialized as its current safe control/current revision, never stale patient payload.

## 7. Status mapping, event governance and closure

These are proposed **semantic** mappings. No BMM literal status names have been confirmed. Sign off a vendor-to-HHCS mapping table with BMM's exact codes before implementation.

| Documented BMM meaning, literal code TBD | HHCS lead status | Resource/control meaning and rules |
|---|---|---|
| Persisted receipt | No lead change | Set delivery acknowledged + external ref; not `accepted` |
| New/unreviewed order | `new` | Only current eligible order; no reset of an accepted lead |
| Accepted full current scope | `accepted` | Record actual acceptance time; proposed partial acceptance is an exception/amendment |
| All required due work scheduled | `scheduled` | Date required; track each occurrence/window; reschedule is revisioned if material |
| One or more resources dispatched | `dispatched` | Show partial counts; no all-resource deployment claim |
| Actual service start/install/on duty | `in_progress` | `deployed` is existing HHCS input alias; resource facts remain separate |
| All agreed obligations completed | `completed` | Completion gate mandatory; unresolved decline/cancel/return obligation blocks |
| Unable to serve | `declined` | Reason required; notify coordinator/supervisor; open requirements remain unresolved |
| Vendor reports cancellation | No automatic privileged cancellation | Record cancellation evidence; reconcile against an authorized HHCS request; unsolicited report is exception |
| Hold/pending approval | No lead enum change | `control_state=hold`; block further fulfilment |
| Vendor error/unknown status | No lead change | Persist sanitized unresolved event and mapping exception; do not guess |

Retain forward graph `new→accepted/declined`, `accepted→scheduled/declined`, `scheduled→scheduled/dispatched/in_progress`, `dispatched→in_progress`, `in_progress→completed`. Privileged cancel/reopen remain explicit actions outside this graph. If actual BMM sends direct `completed` from `accepted`, record evidence and retrieve history/reconcile; do not manufacture schedule/dispatch/start events to satisfy the graph. A separately authorized SQL reconciliation action may apply verified facts with source evidence and missing timestamps explicitly unknown. It cannot weaken role, sign-off or resource-completion gates.

**Event algorithm:** authenticate/verify; derive connection tenant/provider; validate bounded schema; canonicalize agreed fields; lock case, referral, order, then resources in stable ID order; check event key and canonical digest; return original outcome for identical duplicates; reject same ID/different content with 409; verify external ref/order/revision/expected entity version; apply shared SQL workflow and resource facts; record event outcome, timeline and notifications atomically. Use the same lock order in every business action to avoid case/referral deadlocks. Deadlock/serialization retries reuse the event ID.

- Keep event uniqueness scoped to `(connection_id, external_event_id)` and HHCS event IDs, with external ID namespace/type explicit. Existing workspace/UUID event rows can be retained for v1; v2 must bind provider, order, revision and result. Use a canonical collision-resistant digest for new events, not an assumption that current MD5 is an authentication signature.
- A lower source sequence/version is delayed evidence, not permission to regress. Save as ignored-stale with original occurrence time; no business side effects. A future revision or gap is quarantined and reconciled. Timestamps alone do not order concurrent events.
- Same-status progress notes can be append-only events; do not repeatedly call status mutation or reset SLA clocks. Enforce note-only expected revision/entity version.
- Conflicting portal/API/Excel changes return 409 with current revision/status identifiers; caller reloads and submits a new action ID if still valid. Unknown mapping is actionable, never silently coerced.
- Accept original duplicate receipts after withdrawal as historical evidence without re-enabling work. New old-revision dispatch/start events are blocked from advancing fulfilment, recorded as exceptions if they actually occurred; return the current hold/control requirement. Stop/return/cancel acknowledgements must still be recordable.
- `update_referral()` currently infers timestamps. Integration mode must store only observed times and preserve missing values; recorded/received time is separate. Do not call inferred `now()` an actual dispatch/start. Legacy portal semantics need clearly labelled recorded times or explicit actual-time inputs.

**SLA:** keep `provider_accept` and `provider_deploy`, `sla_start/meet/scan` and escalation matrix. Add order/referral/requirement scope where needed so one accepted lead or one resource cannot meet another's timer. Acceptance timer stops at actual acceptance, not receipt. Due-now deployment meets only when all applicable requirements are deployed/active per agreed definition. Additional receipt/sync-delay targets are proposed operational settings, not vendor promises. Withdrawal is recorded as suspended/cancelled with reason, never falsely met. Existing breaches/history remain. Notify the named coordinator and supervisor using existing role/user helpers; include medical desk on clinically material continuity issues.

**Closure:** add a shared SQL predicate before automatic external-only closure and manual case advancement: current revision acknowledged; all included assigned requirements completed or explicitly removed under approved amendment; unresolved declined items have a documented resolution; no pending stop/cancel, held scope, missing resource or unknown delivery; applicable case gates pass. External-only cases still use the existing all-terminal/no-SM closure mechanism after these guards. Mixed SM/BMM cases require BMM completion plus existing SM assignments/samples/payment/report/feedback gates as applicable; BMM completion never closes the mixed case directly. Do not introduce a universal paid-in-full gate where existing provider-only workflow does not have one.

## 8. Amendments, withdrawal and control races

| Change | Immediate HHCS behavior | Vendor action and resolution |
|---|---|---|
| Quantity/unit/coverage/service/date change | Lock order; increment revision; invalidate relevant agreement; mark old release superseded; prevent new fulfilment on unacknowledged scope | Send/retrieve amendment with affected IDs; require exact revision ack. Added work waits for approval; existing unchanged work continues only under an explicit approved continuity decision |
| Address/contact changes | New approved delivery revision and revalidation; invalidate pending old-address delivery | Require BMM acknowledgement before new dispatch; if already dispatched, coordinator confirms rerouting with BMM and family |
| Drop item | Mark excluded locally with reason; publish stop for old assigned scope; never erase already disclosed history | BMM confirms cancelled quantity/resource; dispatched work requires cessation/return disposition. No silent delete |
| Add item | New item ID/mapping/quantity basis and commercial/sharing review | Amend existing order if supported; otherwise controlled replacement generation only after duplicate-risk resolution |
| Sign-off/sharing withdrawn | Atomically place hold and supersede deliverable revisions; publish minimum control; block new release and retry | Stop request acknowledged for exact affected scope; escalate if no ack. New approval alone cannot resume work until prior stop outcome is known and a current release is explicitly acknowledged |
| Reassign provider | Supervisor-approved operational amendment; remove old assignment from future releases; retain old order/contact-control record | Stop old provider's scope and resolve dispatched resources before releasing overlapping replacement work. Buying-cost provider change alone does not perform this |
| Cancel before BMM receipt | Suppress unsent work; if disclosure/delivery attempt may have happened, treat as potentially received | ID-only cancel control and reconcile. Do not infer absence from missing ack |
| Cancel after acceptance/dispatch | Existing authorized `cancel_case`/referral action plus integration `cancel_requested`; local case may be cancelled but order remains unresolved | BMM confirms stopped/not possible/already completed, with resource/return disposition; coordinator handles unresolved safe cessation. No automatic BMM cancellation assumption |
| Reopen | Keep role/reason rules; require renewed approval, eligibility and unresolved-order reconciliation | Reuse old external order only if BMM explicitly supports reopening it; otherwise new generation and new correlation after old generation resolved |

All material writers must invoke the same invalidation/publication helper: item insertion/deletion/scope, schedule, address/contact, recipient assignment, agreement/sharing changes, case cancel/reopen, provider deactivation and connection changes. Use triggers as a backstop for allowed direct updates. Publication and invalidation are in the same database transaction as the business change. Same-total substitution must invalidate just as a price change does.

**Race boundary:** serialize approval/publication/attempt authorization with the case/order lock. A request already in flight or a pull response already serialized when withdrawal commits cannot be recalled. Record that exposure, immediately publish/queue a stop control, require BMM to revalidate the current revision before dispatch, and reconcile cessation. Claiming a queue row is not permission to send: recheck at attempt start. No new release begins after the hold is observed. Never promise distributed exactly-once delivery or instantaneous external cancellation.

## 9. Reliable synchronization

### Preferred candidate: durable pull, explicit acknowledgement

Keep v1 snapshot for compatibility while the new contract is under review. Proposed v2 HHCS endpoints, not implemented:

| Endpoint | Access and purpose |
|---|---|
| `GET /api/v1/bmm/changes?cursor=...&limit=...` | Integration-only BMM principal; current sanitized plan/control changes |
| `POST /api/v1/bmm/leads/{id}/ack` | Same principal; receipt/reference/revision acknowledgement; status/held controls independent |
| Existing `POST .../{id}/status` extended under agreed contract version | Same principal; current order/revision/status event |
| `POST /api/v1/bmm/leads/{id}/resources` | Same principal; per-requirement/resource event |
| `GET /api/v1/bmm/leads/{id}/state` | Same principal; safe current order/control/resource state for reconciliation; no wider case access |

Cursor implementation: per connection maintain an incrementing `change_seq` under a connection-row transaction lock; create feed entries in the same commit as revision/control changes. All publishers acquire that lock in the same global order after case/referral/order locks. Holding it until commit prevents sequence allocation from overtaking an uncommitted earlier publication. Do not use a bare identity/timestamp cursor that can skip a late commit. Entries contain IDs/revision/kind/time, not raw patient bodies. Read committed feed pages `seq > cursor`, ascending, limited to 100, with a captured high-water mark. Serialize authorized current content from the revision only after a current eligibility check; held/withdrawn orders yield minimal controls.

Configuration disable transactions lock the connection only; they must not then acquire case/order locks in the reverse order. Any required per-order invalidation sweep runs separately using the normal case/referral/order/connection order. Multi-case patient/contact updates lock affected cases in sorted ID order. New database tests must exercise these interactions, not only two competing status events.

BMM durably stores each returned entry and correlation before advancing its local cursor. Transport is at-least-once: lost response/cursor restarts replay safely. Per-order receipt/ref ack is separate; a checkpoint means entries were persisted, not that they were accepted. BMM must upsert by stable `(connection, order_id, generation)`, never create one new order per poll/page. A page response containing no entries preserves position. Do not advance to total/count. Event replay may return a newer safe state for the same sequence; processing remains keyed by order+revision/control.

Proposed HHCS consumer-checkpoint action records the highest contiguous persisted sequence. Do not infer it from the highest individually acked order. Retain changes until acknowledged plus an agreed replay window. Proposed starting retention: 90 days for ID-only feed/event metadata, reviewed against the actual replay need; no automatic purge of unresolved orders, ambiguous attempts or dedupe keys still retryable. Immutable patient snapshots need a separately approved retention/deletion policy; never store them in generic logs. A cursor older than retained data returns 409 `resync_required`; a new bounded baseline is generated at a serialized high-water mark, including unresolved controls for previously shared orders, then changes after that mark. Do not fall back silently to offset pagination.

Proposed initial cadence, subject to BMM agreement: incremental fetch every 60 seconds with jitter; reconcile unacknowledged/active orders every 15 minutes, full active-order sweep daily using paged persisted checkpoints. At scale reduce cadence/batch by agreed limits. HHCS shows last persisted checkpoint, oldest unacknowledged revision, last inbound progress and last reconciliation. If BMM cannot provide durable consumption/receipt/reconciliation, pull is not accepted as the primary method.

### Proposed HHCS response and control semantics

Use explicit `contract_version` on v2 feed responses and commands. Keep current v1 routes/response behavior for non-managed compatibility; integration-managed orders reject versionless/v1 mutations once v2 is selected, rather than allowing them to bypass revision controls. BMM must agree the version before any enablement. The added HHCS routes remain proposals until implemented and included in generated OpenAPI.

- Feed response: `{contract_version, connection_id, high_water_cursor, next_cursor, has_more, entries:[{sequence, order_id, referral_id, revision, source_epoch, kind, state}]}`. Cursor is scoped to connection/environment and validated against tampering or a mismatched consumer. A page never claims an acknowledgement. `kind` is one of proposed `release`, `amend`, `hold`, `cancel`, `resume`, `takeover`; current control/eligibility governs serialized `state`.
- Acknowledgement command adds `ack_kind` to the receipt envelope: `received`, `amend_applied`, `hold_confirmed`, `cancel_confirmed`, or `cannot_apply`, plus source epoch and the relevant HHCS control ID. `cannot_apply` requires a reason code and becomes an exception, not success. A transport receipt of a cancellation control does not equal `cancel_confirmed`.
- Hold/cancel confirmation covers exact affected requirement IDs/quantities and confirms no further dispatch/start; already-active resources include explicit stopped/continued-under-approved-handover/return-pending disposition. Partial cessation remains pending. Store actual evidence even when a lead/case is locally terminal, without granting BMM a privileged cancel action.
- Status/resource response: `{event_id, order_id, applied_revision, applied_result, current_revision, current_status, entity_version, duplicate, control_required}`. Persist and return the same original applied outcome on retries, alongside current safe state; a successful historical duplicate cannot imply work may resume.
- Requirement events cover planned/scheduled, resource assigned/replaced, dispatched, arrived/delivered, installed, active, completed, returned and cancelled as applicable to service/type. Staff arrival can be a timestamp without a new lead status; staff completion requires an explicit `completed` resource action/field, not misuse of equipment `returned`. Equipment start does not invent prior install time. Extend `log_deployment` validation accordingly; missing/unobserved transitions stay unknown.
- Proposed bounded reconciliation request/response: `{order_id, expected_revision, reason}` and `{reconciliation_id, outcome, current_revision, differing_fields, outstanding_counts, next_action}`. Coordinator can request lookup of visible orders, supervisor resolves a mismatch with evidence. A request never marks an unknown create safely absent by itself.
- Return 200 only for durable applied/duplicate outcomes; use 202 only for durably queued work with a persisted operation ID and inspectable status. Malformed schema is 400; unauthenticated 401; unauthorized 403; conflicts/stale revision/source epoch/unknown mapping/hold/resync are 409 with a stable `code`; oversized body 413; local rate limit 429 with `Retry-After`; temporary database/service failure 503. No success acknowledgement before database commit. Unowned references produce a non-disclosing missing/not-available response. No patient data in error bodies.
- Extend the existing error envelope `{status,error,message,fieldErrors?,timestamp}` with a bounded stable `code` and safe current-version identifiers where authorized; preserve existing clients. Webhook response behavior must instead honor the actual documented vendor retry semantics when that transport is selected.

Contract-version, event-ID/digest, tenant/provider binding, revision/epoch, and safe retry rules apply equally to API, portal imports and reconciliation actions. Additional proposed operational RPCs are `bmm_sync_history`, `bmm_reconcile_order` and `bmm_retry_operation`; expose only their explicitly authorized roles in `data.ts`. No direct table edit is an operational retry.

### If BMM requires push: database outbox

Only implement this after receiving its real API. One BMM-specific `bmm_outbox` row per `(connection, order_id, revision, operation)` is inserted transactionally with the approved business change. Payload is a reference to the immutable revision; request digest and idempotency key pin the exact content. Never overwrite a payload under an existing idempotency key. Hold/cancel controls are independent operations and may be sent while full-plan eligibility is false, with minimum identifiers only.

Proposed row state: `pending`, `claimed`, `retry_wait`, `delivered`, `unknown_outcome`, `failed`, `superseded`, `blocked`; fields include attempt count, next attempt, lease token/expiry, attempt-start time, request digest, sanitized HTTP/result code, external reference and timestamps. Unique constraints enforce one logical operation; per-order serialization prevents concurrent creates or contradictory amend/cancel calls. Do not keep a Postgres transaction open across `fetch`.

Processing:

1. Existing cron atomically claims a small due batch using `FOR UPDATE SKIP LOCKED`, a random fencing token and 120-second lease; initially at most five operations/tick, bounded further by measured free-plan CPU/subrequests and vendor limits. Priority: stop/withdrawal, then reconciliation, then new releases. Lease and batch numbers are proposals, tuned in sandbox.
2. In a short transaction recheck current eligibility, operation applicability, pending controls, current revision and account; record `attempt_started_at` before network I/O. Noncurrent unsent release becomes Superseded. Unknown prior create blocks another create for the same order generation.
3. Fetch only the approved vendor endpoint/auth, proposed 15-second timeout, redirects rejected. Use stable correlation and vendor-supported idempotency key, e.g. digest of connection/order/generation/revision/operation. HTTP acknowledgement must be validated; malformed success without required reference is not a confirmed delivery.
4. Save result only if lease token still owns the claim. Fencing protects local updates, not the vendor: external idempotency or lookup is still essential. If process dies after attempt start and before result, expired lease becomes Unknown outcome, not a fresh create. If it died before recorded attempt start, reclaim safely after expiry.
5. Retry known transient failures with full-jitter backoff capped at 30 minutes, initially eight attempts/24 h maximum. Proposed base one minute. Honor valid `Retry-After` and connection-level next-allowed time. Persist delays; never sleep for retries in the Worker. Bad auth disables sending for the connection and alerts supervisor/config owner; schema/permission/contract 4xx stop for correction; 429 delays; timeout/5xx on a mutating request may be ambiguous, not safely failed.
6. For ambiguous create, first lookup by the agreed unique HHCS correlation or repeat with the same vendor-supported idempotency key and guaranteed semantics. Without either, manual vendor reconciliation is mandatory; never blindly create again. Verified no-order evidence authorizes reattempt, verified existing order links reference, duplicate references open an incident. Operators cannot mark an unknown create Pending merely to clear an error.
7. If supported amend/cancel operation has uncertain outcome, reconcile current BMM revision/state before further conflicting actions. Never send an old revision over a newer plan. Stop controls remain actionable even if the new full-plan revision is ineligible.

Webhook alternative: verify BMM's documented raw-body signature and replay window before interpreting JSON; bind signed account to connection and event identity. Persist verified inbox/event and apply in one transaction before success response. If async processing is required, acknowledge only durable storage, and persist processing/retry status; lease recovery follows the same rules. Invalid signature never enters business processing. Duplicates return durable original outcomes. Webhook response/status retry semantics must match BMM documentation, not an invented convention.

Polling alternative: persist per-connection BMM cursor/high-water mark/next-poll time; page by documented vendor semantics; atomically save each page's events and checkpoint; overlap time windows only with event/entity-version dedupe; run periodic active-order lookup to catch missed changes. A missing order in one page is not a cancellation. If vendor retention/gaps invalidate cursor, baseline reconcile before advancing.

### Reconciliation, manual actions and fallback

Compare HHCS order generation/ref/revision/assignment and expected obligations against BMM's documented order lookup/status/resource snapshot or reviewed manifest. Classify: matched, awaiting receipt, stale revision, missing order, duplicate order, status conflict, incomplete coverage, stop pending, orphan resource, unknown outcome. Save IDs, comparison time, differing field names/counts and outcome; patient details stay in restricted case records. Coordinator resolves clinical/operational scope; supervisor authorizes exceptional reconciliation or resubmission; admin manages configuration without viewing patient data.

Portal/Excel/file modes share the same order/revision/events and SQL guards. Store `source_mode` and `source_epoch` on each order. Only one source owns fulfilment updates at a time. Supervisor takeover locks the order, increments epoch and pauses machine mutations; BMM gets hold/takeover control. Already issued stop acknowledgements and authenticated evidence may still be recorded as non-advancing reconciliation evidence. Return to automation requires snapshot comparison, resolution of all manual changes, current acknowledgement and a new epoch, never last-write-wins.

Proposed file manifest includes batch ID, export time, provider, order/referral/item/requirement IDs, revision/epoch and exact approved quantity/unit/date fields. Use the agreed secure channel, not an assumed email attachment. Import supports preview, row errors, event IDs or deterministic row identity, expected revisions and acknowledgement reference. Repeated batch/row does not repeat actions. Existing 500-row status import can be extended with a versioned template; legacy imports without revision are rejected for integration-managed orders. Resource completion requires the agreed resource manifest or explicit reviewed evidence. Manual entry remains auditable; Excel is not API proof.

## 10. Security and operational screens

### Boundary and credentials

- Pull reuses Supabase ES256 verification, active profile/provider/workspace checks and `asUser` transactions. Add `profiles.integration_only` (default false, admin/service managed) plus connection-bound identity. Deny this principal generic batch/data/RPC, recordings, AI, staff sessions and unrestricted live updates; allow only named BMM machine routes and minimal identity/readiness route. Enforce the restriction before `/me`/special route early returns and in SQL helpers/RLS for generic access, not just hidden UI. BMM business RPC execution must still validate the connection. Existing human provider portal keeps its own credentials and scoped role rules; tighten integration-managed plan access during holds/withdrawals as required, with separate review of legitimate human access.
- Auth/security counters may use existing cached identity infrastructure, but sensitive connection enabled/hold checks occur in the transaction. Revoking the connection or machine principal blocks further exchange even while an access JWT has not expired. Do not send a Supabase service-role key to BMM. Agree whether BMM can refresh tokens securely with its dedicated login; if not, document and implement a narrowly scoped alternative after contract review, not by weakening JWT verification globally.
- System webhook/cron work uses `asSystem`, with explicit connection/account/workspace/provider predicates in every operation. Never use incoming tenant/provider IDs as authorization. All FK relationships must enforce same workspace/provider, including new child tables.
- Keep vendor credentials server-side in a restricted settings/secret mechanism following existing integration patterns; UI receives present/version/last-rotated/last-tested metadata only. Rotation: configure next version, test non-patient auth, cut over under connection lock, retain documented overlap for verification if supported, retire old version; pending attempts recheck current credential version. Never print secrets, tokens or whole errors containing request bodies.
- Before any webhook body is consumed by `readJson`, add a BMM-specific bounded raw-body branch in `cloudflare/src/index.ts` only if the selected vendor contract requires it. Do not mark a patient business endpoint `public`; add a distinct documented signature-verification path and lint/rehearsal checks. Reuse the established webhook entry pattern without sharing MyOperator credentials.
- Proposed machine/event body cap 64 KiB, max 100 events/page and existing note cap 2,000 characters; enforce actual streaming byte limit even when `Content-Length` is absent, plus JSON depth/array/string bounds. Page full plans by bytes as well as item count. A single plan larger than the cap requires an agreed paged-item protocol or reviewed manual handling, not silent truncation. Agree vendor limits before fixing final caps.
- Outbound URLs, if needed, come from approved documented HTTPS hosts, not user-submitted per-lead URLs. Reject credentials/fragments/custom ports, localhost/private/link-local/IP literals and redirects. Maintain exact host/path allowlists; no arbitrary DNS destinations or URL concatenation from event content. If BMM requires downloads/attachments, add a separately reviewed, size/type/expiry-bound mechanism only after demonstrated need. No default attachment forwarding.
- Sanitize external errors to stable codes; replace current full error-object logging on integration paths with IDs/outcomes only. Do not store raw request/response payloads in access/audit logs. Protected snapshots/inbox are business records with explicit retention and RLS, excluded from generic audit-change payload capture. Use hashing for duplicate detection, not as a substitute for authentication or sensitive-data retention controls.

### Settings → Telephony & integrations → Book My Medicare integration

Extend `BmmIntegration()` in `src/pages/Settings.jsx`, retaining existing flat UI components and skeletons. Show one dense configuration form and operational summary:

- Environment clearly labelled Sandbox or Production, isolated connection/account identity; sandbox cannot point at the production BMM account or use real HHCS patients. Choose transport only after contract confirmation.
- Prerequisites: BMM provider active; integration-only identity or approved vendor auth present; contract/mapping versions approved; minimum sharing policy approved; successful sandbox acceptance evidence; coordinator ownership policy; explicit release authorization recorded. Each unmet prerequisite links to its resolution.
- Credential status: absent/present/expired/rotation due, last test/version; masked status only, no Show secret control. Admin may manage config but cannot open patient sync history.
- **Test connection** calls a documented read-only identity/health endpoint, or for pull uses a BMM authenticated self-test handshake that returns no leads. Until BMM performs that handshake show Awaiting BMM verification; a local config check is not a connection test. If vendor has no safe test endpoint, show Not available and use an agreed synthetic sandbox test. Never create a production patient order as a test.
- Distinct badges: **Configured**, **Connection verified** (environment/account/test time), **Sandbox order exchange verified**, **Live order exchange verified** (only after separately authorized real exchange and reconciliation). Successful auth never promotes to live exchange verified.
- Enable/disable controls use backend gates, role/reason audit and environment. Re-enable does not replay stale backlog: present counts of eligible, superseded, unknown and stop-pending orders, then reconcile before resumptions. Disabling pauses new delivery/fulfilment; it does not mean BMM has stopped existing work.
- Last successful send/fetch/receipt/progress/reconciliation separately; queue/feed lag, unknown/failed count, next retry and sanitized actionable error. Supervisor can open case-linked work; config-only admin sees counts/codes only.

### Provider leads → open lead

Extend the existing modal/detail in `src/pages/Leads.jsx` and reused `LeadActions`. Display HHCS case/referral/order generation, BMM reference, approved/acknowledged revision, source mode/epoch, partner state and control state. Show one row per item/occurrence with required quantity/unit/coverage, scheduled, dispatched, arrived/installed/active/completed counts and missing work. Expand to existing `v_deployments` resources; timestamps in IST labelled Actual or Recorded/Unknown as appropriate.

History lists event time, receive time, source, revision, action, outcome and reference; no credentials/raw payloads. Human provider controls use shared SQL guards; machine principals cannot open this portal. Coordinator may request read-only reconciliation of visible assigned orders; supervisor may retry a known-safe operation or resolve a conflict with required evidence/reason. Unknown create offers Reconcile, never blind Retry create. Admin has no patient detail or per-case retry action. Reopen/cancel retain existing supervisor/client-manager permission rules; coordinator handling of an exception does not imply those powers.

### Cases → open case → Providers

Extend `src/pages/CaseDetail.jsx`, with transition summary in `Transition.jsx` as needed. Show partner receipt separately from acceptance, BMM ref/revision, partial requirement progress, stop/amendment acknowledgement, sync exception and next owner action. Named coordinator and supervisor receive existing live refresh/notifications. Completion badge only follows shared completion predicate. Keep calls/recordings and internal clinical/commercial sections inaccessible to provider identities.

Error text explains action: Renew approval, Map service/unit, Awaiting BMM receipt, Resolve uncertain order, Confirm resource return, Reconcile manual updates, or Rotate credential. Retain Terms/Privacy links and project UI rules; no new card grid, visual library or UI dependency.

## 11. Required implementation changes and exact locations

All names in this section marked new are proposed. Create new timestamped idempotent expand migrations; do not edit historical applied migrations. Do not create a migration file as part of this design task. Choose timestamps at implementation time after checking existing filenames.

| Location | Required implementation |
|---|---|
| New `supabase/migrations/YYYYMMDDHHMMSS_bmm_order_control.sql` | Extend `bmm_integration_settings` with environment, transport, contract/mapping versions, verification evidence, pause/health metadata and identity binding. One active account per workspace/provider/environment. Add integration-only profile protection and scoped sharing evidence; revoke direct writes |
| Same migration: new `case_referral_items` | Explicit case-item/referral assignment, same case/workspace/provider constraints, validity/reason. One active fulfilment assignment per item unless an explicitly modelled split quantity is approved; initial implementation rejects splits |
| Same migration: new `bmm_orders` | Connection/referral/generation, external ref, current/acknowledged revision, partner/control/delivery state, source mode/epoch, next action/reconciliation times; unique reference per connection and active-generation constraint |
| Same migration: new `bmm_order_revisions` | Immutable `(order_id, revision)`, kind, minimal protected plan snapshot, digest, agreement/sharing evidence, material fingerprint, created/approved/revoked evidence. Snapshot is business data, not audit log |
| Same migration: new `bmm_requirements` | Stable item/occurrence/window, required quantity, quantity basis, unit/coverage/return rule, revision validity and status. Snapshot schedule changes by revision, preserve previous fulfilment history |
| Same migration: new `bmm_service_map` | HHCS service+unit+coverage/basis to documented BMM code/unit, version/environment, explicit transformations. Admin/supervisor configuration only; no cost fields |
| New `..._bmm_exchange.sql` | Extend existing `bmm_status_events` as protected event ledger with connection/order/revision/type/external ID/digest/times/outcome; existing rows remain historical v1. Add `bmm_changes` and checkpoint functions for pull **or** `bmm_outbox` for push, not both without need. Poll checkpoints only if polling selected |
| SQL functions replaced in new migrations | Shared `bmm_release_order`, `bmm_apply_event`, `bmm_acknowledge`, `bmm_reconcile_order`, safe retry and control/withdraw actions. Internal helpers for eligibility/invalidation, requirement aggregate and closure. Role checks inside; system-only helpers not added to browser RPC map |
| Existing `record_signoff`, `recalc_case`, `set_item_scope`, `set_intake`, `route_case`, case cancel/reopen triggers/functions | Bind approval to fingerprint; invalidate same-total scope/date/contact changes; route discovery separately from release; publish controls transactionally; stopped orders cannot auto-reopen via category routing |
| Existing `update_referral`, `log_deployment`, `import_referral_updates`, `case_gates`, closure branch | Central revision/hold/source-mode guards across API/portal/Excel; actual timestamps; requirement-safe completion; role restrictions; scoped SLA behavior. Preserve legacy non-managed referrals through an explicit compatibility branch, not silent bypass for BMM-managed orders |
| `partner_deployments` additions | Order/requirement/external assignment ID, resource version, actual arrival/completion fields and replacement link; composite uniqueness. Do not overwrite historical resources on a replacement; no missing item linkage on managed orders |
| Every new table | RLS enabled, least-privilege grants, same-tenant checks and protected views using `me_ws`, `app_uid`, `has_role` as appropriate. Internal credentials/feed/outbox/inbox deny direct `caredesk_app` access; narrow SECURITY DEFINER actions with pinned `search_path`, revoked PUBLIC execute. Rerun change-tracking trigger loop, exclude PHI snapshots from generic audit payloads |
| `cloudflare/src/services/bmm.ts` | Extend current handlers for selected agreed contract; add connection-bound projection, ack, resource events and safe error mapping. New dedicated `bmm-sync.ts` only if push/poll needs a worker; no generic adapter framework |
| `cloudflare/src/index.ts`, `api/auth.ts`, `api/context.ts`, `api/http.ts` | Machine-identity route confinement, fresh enabled checks; bounded body handling; only if vendor callbacks selected, raw-body verification entry before JSON parser; sanitize integration exceptions |
| `cloudflare/src/api/routes.ts` | One line per actual selected endpoint with access before handler; explicit callback verification metadata if needed; no unrestricted public business endpoint |
| `cloudflare/src/services/data.ts` | Read-only minimized sync views in `READ`; explicit role-bound RPCs and read-only `READ_RPC`; no browser write access to state/credentials/outbox; preserve current commercial confidentiality |
| `cloudflare/src/db.ts`, `env.ts` | Add Worker-used tables/columns to `SCHEMA`; retain `asUser/readAsUser/asSystem`, typed arrays/JSON. If push requires credentials, add only actual documented secret names and rotation handling |
| `cloudflare/src/services/cron.ts` | Selected bounded sync/reconciliation sweep alongside existing minute tasks; persisted work recovers next tick. Invoke scoped SLA scan; no untracked background obligation |
| `src/api.ts`, `src/lib/api.js`, demo stand-ins if applicable | Add actual UI connection-test/sync calls in sole API caller and demo boundary; screen RPCs via `db/rpc`. Synthetic data only for explicitly local/demo tests, never live status |
| `src/pages/Settings.jsx`, `Leads.jsx`, `CaseDetail.jsx`, `Transition.jsx` | Behaviors in section 10; preserve unrelated in-progress changes. Existing named coordinator access suffices when assignment enforced; add narrow sync view policies, not blanket coordinator patient access |
| `cloudflare/test/bmm.test.ts`, new `bmm-sync.test.ts` only if needed, `workflow.test.mjs`, `api.itest.mjs`, rehearsal stand-in | Tests in section 12; include real Postgres multi-connection concurrency proof in disposable rehearsal beyond PGlite's serial checks |
| `docs/BMM-INTEGRATION.md`, this design, SOP/data dictionary, generated docs | Replace tentative wire contract only after agreement; update operating instructions; regenerate schema/OpenAPI through rehearsal. Do not claim draft v2 endpoints exist |
| `PROJECT.md`, `.github/workflows/ship.yml`, deployment scripts | Maintain hold text until explicit release. Add vendor secrets to existing secret upload only if selected transport requires them. Single existing ordered ship pipeline; no second deployment path |

This is a list of implementation work, not files changed by this task. Do not create every transport's tables in anticipation. Resource, consent, revision and completion controls are required regardless of selected transport.

## 12. Test matrix and measurable acceptance

Local fixtures must be synthetic. Tests never read production credentials/patients or contact BMM unintentionally. BMM sandbox tests require actual vendor documentation/account and cannot be replaced by stand-ins. Production verification requires separate explicit authorization after the release hold is lifted.

| ID | Scenario and assertions | Stage |
|---|---|---|
| A1 | Missing/forged/expired JWT denied; inactive identity/provider/connection denied; same JWT cannot continue after disable | Local API + real sandbox auth |
| A2 | Cross-workspace/provider/order/ref/resource/event attempts return no data and make zero mutations; admin cannot read patients; administrator inheritance remains consistent | Local SQL/API |
| A3 | Integration-only login cannot use batch/data/RPC, recordings, AI, live feed, staff sessions or portal clinical views; providers never obtain recordings/assessments/cost/margin data | Local SQL/API |
| G1 | No assessment/sign-off/current sharing grant: zero patient fields released, no outbound create; text-only/empty/unassigned plan blocked | Local + sandbox synthetic orders |
| G2 | Equal-total substitution, dropped/added item, address/date/coverage change, expired/revoked sharing: revision changes and old delivery/retry cannot publish full plan | Local race tests |
| D1 | Mixed SM/BMM items, dropped items, mutable catalogue unit, legacy unit absent, unmapped service: only current explicitly assigned included lines with agreed units; legacy ambiguity blocks | Local projection + vendor mapping |
| D2 | Quantities distinguish simultaneous staff, visits and rental units; 12 h cannot meet 24 h; schedule/date timezone and end-exclusive period boundaries survive roundtrip | Local + vendor sandbox |
| R1 | GET success alone not received; receipt stores BMM reference/revision once; differing reference/duplicate external order opens conflict | Local + sandbox |
| E1 | 100 identical event retries create exactly one mutation/timeline/notification; same ID/different body 409; rolled-back event may retry safely | Local SQL/API + sandbox |
| E2 | Delayed/out-of-order/unknown/future-revision events never regress/fabricate workflow; gap recorded; source and receive times retained | Local + documented vendor events |
| E3 | Simultaneous portal/API/Excel changes enforce version/source epoch; losing action conflicts; permissions for cancel/reopen unchanged | Local multi-connection Postgres/API |
| F1 | Two staff + one equipment: one active resource cannot mark full deployment, meet full-scope SLA or close case; per-occurrence completion and replacements do not double-count | Local SQL/UI + sandbox |
| F2 | Decline notifies named coordinator/supervisor; unresolved declined obligations block closure; authorized resolution preserves history | Local SQL/API/UI |
| F3 | BMM-only complete closes exactly once after all guards; mixed case stays open until existing SM gates; cancelled/held/unknown orders cannot auto-close | Local workflow/API |
| C1 | Withdrawal before publication, after claim, after serialization/send, after receipt and after dispatch: no new eligible release; stop obligation persists and is reconciled; no auto-resume | Local concurrency/fault injection + sandbox |
| C2 | Cancel before/after acceptance; vendor cannot stop immediately; reassignment/reopen: no false cancel confirmation or overlapping replacement create | Local + sandbox |
| P1 | Pull lost page/ack, restart, concurrent commit, baseline/retention reset: no committed change skipped; duplicates safe; no PHI on held tombstone | Local Postgres + BMM consumer sandbox |
| P2 | Push two workers/lease expiry/crash before send/after send/before save: one logical external order; safe claim recovery or Unknown outcome; no stale worker overwrites result | Local mock + Postgres + sandbox, if push |
| P3 | No vendor idempotency, ambiguous timeout: create attempts remain one until documented lookup/manual evidence resolves; operator Retry cannot bypass | Local + sandbox, if push |
| X1 | 429/Retry-After, outage, malformed success, 401/403, invalid schema, rate ceiling, request size/depth, redirects/internal URLs and forged/replayed webhook | Local fault/security tests + vendor sandbox |
| X2 | Worker interruption/cron gap/backlog recovery: work persists, bounded batches drain safely; oldest lag visible; no in-memory work loss | Local/disposable rehearsal |
| M1 | Excel duplicate file/row, stale revision, machine event during manual epoch, partial row errors; takeover and return reconcile explicitly | Local SQL/API/UI + agreed file rehearsal |
| S1 | Test connection performs zero create calls; Configured/auth verified/sandbox exchange/live exchange badges cannot substitute for each other | Local/UI + sandbox |
| S2 | Logs/audit/notification snapshots checked with synthetic marker strings: zero secrets, patient payloads, raw clinical notes or buying costs | Local + authorized sandbox logs |
| S3 | Named coordinator retains BMM-only visibility; unassigned coordinator has no broader access; supervisor sees exceptions; admin sees config/counts only | Local role/API/UI |

Acceptance before release:

1. All applicable matrix rows pass; maintain evidence references per row, including raw vendor contract version and synthetic test IDs. Existing two BMM tests alone do not satisfy this matrix.
2. Zero transfers without current approval/authorization; zero other-provider/dropped items and confidential fields in projection; zero unauthorized cross-tenant mutations.
3. Replaying 100 identical creates/receipts/status/resource events yields one logical order/action and one notification per meaningful action; ambiguous unsupported creates are blocked for reconciliation, not retried.
4. Inject interruption at every persisted attempt boundary and recover without lost required work or fabricated success. Two concurrent workers/transactions cannot skip feed commits, duplicate a known external order, or overwrite newer revisions.
5. Partial-deployment scenario never meets complete deployment/closure predicate. All required shifts/visits/equipment quantities reconcile before Completed. Every cancellation/hold has a visible pending/confirmed outcome.
6. Proposed operational targets for agreement: within two one-minute sync opportunities under healthy sandbox conditions, receipt/progress appears in CRM; unknown outcomes/stop failures visible on the next sweep, initially within two minutes; reconciliation scheduled every 15 minutes and daily sweep completes without missing pages. These are HHCS acceptance targets, not confirmed BMM SLAs or guaranteed performance during outages.
7. Measure at the agreed peak synthetic volume on existing free plans: bounded request bytes, queries, CPU/subrequests, queue/feed lag and drain rate. Must complete within available plan limits while existing SLA/call/AI cron work still runs. If it cannot, reduce batch/cadence/volume or agree scope; no paid infrastructure is implicitly authorized.
8. Actual BMM sandbox must demonstrate create/link, receipt, accept/decline, amend/withdraw/cancel, resource progress, duplicates and uncertain-outcome lookup for the chosen method. Any unsupported critical action has an explicitly accepted manual exception process and release gate.
9. Full project checks pass before any later ship: in `cloudflare/`, `npx tsc --noEmit`, `npm test`, `npm run rehearse`; root `npx tsc --noEmit`, `npm run build`, `node scripts/check-api.mjs`, `node scripts/lint.mjs`. Run real disposable Postgres concurrency checks in addition to local PGlite tests.

This review ran only the existing focused local BMM test file. The latest working-tree run is blocked in the concurrently added closure migration's view replacement as described in section 1; the earlier two-test pass applies to the earlier snapshot. The matrix, full build/rehearsal, BMM sandbox and production verification remain future implementation work.

## 13. Phased implementation and release procedure

### Phase 0: completed by this task

Inspect current source/repository/deployment evidence, identify gaps, deliver this functional design and vendor information request. Preserve existing work and release hold. No adapter code, migrations, new settings or vendor communication executed.

### Phase 1: possible locally before BMM documentation

After implementation is authorized, add explicit assignment, revision/material-change holds, scoped authorization evidence, requirement-safe resource/closure guards, machine-identity confinement and synthetic regression tests behind disabled settings. Build current UI exception/history models. No transport-specific endpoint assumptions, credentials or outbound live order code. Update inaccurate current settings copy. Keep all changes local until release is separately authorized; phase 1 is a proposed next phase, not part of this design task.

### Phase 2: dependent on BMM documentation

Review product/account/version/security/limits; select one transport using section 2; sign exact mapping/status/error/retry/cancellation contract and synthetic cases. Decide supported amendment/reopen/partial-acceptance behavior. Implement only documented adapter/feed/ack/resource endpoints and safe non-patient connection test. If no API, agree file workflow and label it accordingly. Record unresolved requirements as blockers, not invented defaults.

### Phase 3: local then real sandbox acceptance

Run local role/security/fault/concurrency matrix and required project checks. Use distinct BMM sandbox connection/account plus synthetic HHCS workspace only; prohibit any patient export. Complete actual sandbox scenarios with BMM technical contact through separately authorized communication. Store acceptance evidence and explicit internal sign-off. Sandbox passing proves selected contract, not production readiness.

### Phase 4: deployment, only after explicit release authorization

1. Re-read current repo/working tree, remote revision, successful deployment evidence and unresolved orders. Review complete diff; `scripts/ship.mjs` stages all changes and pushes `main`, so unrelated edits must be consciously resolved before running it. No ship command is executed or recommended for immediate use while HOLD remains.
2. Reconfirm production configuration is disabled without silently assuming migration defaults will overwrite existing settings. Because earlier BMM code has deployment evidence, audit existing production settings and any previously shared orders under separate authorization. Keep machine principal unissued/inactive until prerequisites pass.
3. Take an approved database recovery checkpoint and record release revision/migration versions using existing operations; apply only idempotent expand migrations through the existing pipeline. Never manual production DDL. Run full checks, then the existing ship workflow; monitor the exact SHA through migration, deploy, smoke and record. Failure after migration is not a database rollback.
4. Verify deployed code/version and disabled-path checks without patient exchange. Record deployment success separately from activation. Refresh AI Studio from the released GitHub revision before its next edit session.

### Phase 5: activation and initial verification, separately authorized

1. Confirm BMM production account, environment, credentials, contract/mapping version, data purpose, coordinator ownership, response/escalation contacts and safe-cancellation process. Perform non-patient connection test only. `Configured` and `Connection verified` remain distinct.
2. Reconcile any backlog/previous external orders and manual source epochs before enablement; supersede stale releases, resolve unknown creates, retain pending stop controls. Never bulk release historical eligible cases merely because a toggle changed. Start with an explicitly approved limited cohort.
3. Supervisor/administrator enables production under existing authorized settings rules with release evidence. Admin configuration does not grant patient actions. Observe first authorized real order end to end through receipt/external reference, acceptance, individual progress, exceptions and reconciliation. Only then record Live order exchange verified.
4. Monitor next scheduled sweeps and lag/exception counters; expand cohort only after agreed acceptance. Production verification is not performed in this task and requires permission to use actual patient data under approved scope.

### Disablement and incident reconciliation

Supervisor/admin disables connection with a reason; backend blocks new plan deliveries and advancing machine fulfilment updates immediately on fresh transaction checks. Pause outbox/poll jobs and return no further patient plans. Persist pending controls/unknown attempts. Disabling is not cancellation of dispatched work and does not revoke data already disclosed.

If signature-verified inbound receipt/stop/return evidence is supported, allow a narrowly scoped **reconciliation-only** mode for already shared orders, without accepting new fulfilment commands or releasing patient details. A hard security shutdown may block all machine ingress; use coordinator-authorized manual reconciliation instead. Expose this distinction in settings; current implementation simply blocks machine requests when disabled and will need extension for reconciliation-only operation. Human portal/file fallback uses explicit source-epoch takeover and current eligibility guards, not an ungoverned bypass.

Coordinator inventories last confirmed BMM references, active resources, pending stops, unsent and ambiguous attempts; supervisor reconciles each with verified vendor evidence. Deduplicate references, preserve event history and assign owners/due dates. Do not clear failures en masse or delete the ledger to reset the connection. Re-enable only after credential/config repair, current-plan approval and reconciliation of prior outstanding work.

### Rollback

Disable/pause before code rollback; preserve order/event/feed/outbox/resource evidence and unknown outcomes. Confirm a known-good compatible `deploy-*` tag using deployment records, then use existing GitHub `ship` workflow `ref` with `skip_db=true` only under release authorization. Database migrations remain; use forward corrective migrations for data/schema issues. Do not blindly roll back to the old BMM v1 code: it lacks new revision/resource/identity guards. Keep machine identities inactive and connection disabled, or choose a compatible release that enforces the pause; if necessary ship a forward fix. No resource or cancellation state is restored by rolling code back. Reconcile BMM state before resuming any exchange.

## 14. Review decisions still required

- BMM technical/product documentation and contact, sandbox and actual authentication/API capabilities.
- Approved minimum fulfilment/sharing categories and evidence requirements; optional instructions/attachments only if needed.
- Service quantity/unit/coverage and exact status/event mappings, actual timestamps, partial acceptance and amendment rules.
- Durable consumption/acknowledgement or idempotent create/lookup guarantees; cancellation/stop and uncertain-outcome procedure.
- Operational SLA/retention/cadence/volume acceptance, manual ownership and release contacts.
- Coordinate the concurrent closure-gate work: repair its current migration setup failure, agree which closure policies also apply to the separate automatic provider-only path, and enforce the agreed policy consistently without duplicating that work.
- The user has authorized publication/deployment of the current HHCS-side preparation and design. Implementation of the proposed extensions and activation of actual BMM exchange still require the documented interface, acceptance evidence and applicable authorization; publication alone does not complete that connection.
