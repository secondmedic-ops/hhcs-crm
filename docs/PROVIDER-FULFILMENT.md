# Medicare portal: login setup and field fulfilment

Use the CareDesk sign-in at https://hhcs-caredesk.secondmedic.workers.dev. Decision of 20 October 2026: BMM works directly in this portal, with SecondMedic giving them support. There is no integration with BMM's own software. No actual staff accounts were created during implementation; names and emails can be added later.

## Accounts and navigation

| Person | Settings → Users → Add user | Access |
|---|---|---|
| Medicare coordinator | Role: Provider; Provider: Book My Medicare | Provider leads → accept lead → Track fulfilment; or Provider fulfilment |
| Medicare delivery/service staff | Role: Field staff; Provider: Book My Medicare | Sign in → My provider jobs; only assigned provider work |
| Hinduja | Existing Client manager / Client clinical roles | Provider fulfilment, read-only |
| SecondMedic | Existing Supervisor / authorized case Coordinator | Provider fulfilment; Cases → open case → Providers → Track fulfilment |

An administrator/platform admin creates logins once names and emails are known. Leave Provider empty for existing SecondMedic field staff. Jobs can be planned unassigned; dispatch requires an active field login from the same provider.

## Operating sequence

1. Capture enquiry, assessment, included services and commercial agreement in the existing case workflow. Post-discharge cases require current family sign-off.
2. Route the services to BMM. Its provider coordinator accepts the lead.
3. Choose Plan work order for each agreed service unit. Select staff/service or equipment/product, schedule, service/shift end, setup/return requirements and an optional field assignee. Each job fulfils one unit: plan each shift, visit and physical product quantity separately. No automatic quantity conversion or multiplication by plan days.
4. A manager assigns/reassigns or reschedules before dispatch. Overlapping staff/service shifts for the same person are rejected. A delivery person may carry several equipment units.
5. Field staff updates the assigned job:
   - Staff/service: Scheduled → Dispatched/en route → On site → Service active → Completed.
   - Equipment: Scheduled → Dispatched → Delivered → Installed → Service active → Completed → Returned when setup/collection is required. Products without setup or rental can move from Delivered directly to confirmed completion.
6. Delivery requires an equipment serial. Completion/return requires a recipient or handover confirmation name and an explicit confirmation. A staff service cannot finish before its scheduled end. Events record the signed-in person and server time.
7. Report problem keeps the current work stage and notifies the supervisor and named case coordinator. Only a provider manager or authorized SecondMedic manager resolves the problem, with a resolution note. Progress waits while a problem remains open.
8. Managers cancel scheduled/dispatched jobs with a reason. Stopping active staff care also requires safe-handover confirmation. Delivered equipment must be returned physically instead of silently cancelled. On cancelled cases or dropped items, required return and cessation evidence remain recordable.
9. A cancelled job does not fulfil an included service: plan a replacement or resolve the scope through the existing authorized agreement/sign-off process. Case cancellation and lead reopening retain their existing role rules.
10. Every included unit, unresolved problem and required return is checked before lead/case completion. One nurse starting does not fulfil all nurses and equipment. Mixed SecondMedic/BMM cases retain the existing SecondMedic stages and gates.

## Live oversight

Hinduja and SecondMedic see the same job statuses, unit completion counts, staff assignments, timestamps, open problems and event history. The existing WebSocket refreshes affected screens; a visible-tab 30-second refresh recovers missed updates. This records progress and handover evidence; it does not provide continuous GPS tracking or a biometric/digital signature.

## Access and reliability

- Workspace/provider/referral/item checks are enforced in SQL. Field staff see only their own jobs and minimal delivery details, without full-case access, recordings, assessments or buying costs/margins.
- Hinduja monitors read-only. Config-only admin cannot read fulfilment patients.
- Stable creation request IDs return the same work order on retries. Update event IDs and expected versions prevent duplicate events and stale overwrites.
- Managed leads cannot bypass unit-completion/return guards through old buttons, imports, status API or ordinary case closure. Legacy non-managed work stays compatible.
- Missing post-discharge sign-off, dropped items, cancelled leads and closed cases block new fulfilment. Resolve scope and agreement before resuming; safe return/cessation and issue evidence remain recordable.
- Audit records retain identifiers, status and version only. Recipient names, serials and notes remain protected business data.
- Up to 100 recent visible leads, the first 500 jobs and 200 recent events are shown. Select a specific lead to narrow its work. Required/completed unit totals are computed independently.

## Implementation and proof

The provider_fulfilment_portal migration expands existing case referrals and partner deployments and adds a protected event ledger. Existing view-column order is preserved. Browser actions use provider_portal, plan_provider_job and update_provider_job through the existing JWT/RLS RPC boundary.

Synthetic SQL tests exercise assignment, overlapping shifts, roles, duplicates, stale versions, issues, recipient confirmation, partial completion and returns. API rehearsal exercises JWTs, later account creation, read-only Hinduja access, completion guards and live invalidation reaching both Hinduja and SecondMedic. These tests do not use real patients or provision real staff accounts.
