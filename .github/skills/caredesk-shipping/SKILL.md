---
name: caredesk-shipping
description: "Ship Supabase + Cloudflare Worker + React changes safely. Use for migrations, API routes, contract updates, frontend changes, preflight validation, deploy orchestration, and rollback decisions in this project."
argument-hint: "Describe the change to ship or validate"
user-invocable: true
disable-model-invocation: false
---

# CareDesk Shipping Workflow

## When to Use
- A change touches the database, Worker API, route contract, frontend consumer, or deployment pipeline.
- You need to prepare a safe production push from the repo into GitHub/Cloudflare/Supabase.
- You want to validate a feature or fix before shipping or to handle a failed ship step.

## Core Rules
- Read the project-specific source of truth first: `PROJECT.md`, then `CLAUDE.md`.
- Treat `docs/schema.md` and `docs/openapi.json` as the generated map for the database and API contract.
- Read only the exact service file(s) and screen(s) affected by the change.
- Never assume a stack mismatch; if a premise is wrong, correct it before acting.
- Do not change Cloudflare or Supabase infrastructure casually; prefer the repo’s scripted workflow and enforced checks.
- Follow the no-vibe-coded UI rules: no gradients, black-and-purple patterns, glass effects, fake testimonials, rounded-card-heavy styling, or em-dash-heavy copy.
- Keep all money handling in server-side SQL and `numeric` values; never do JS float arithmetic on money.
- Every endpoint must be protected by the correct role access and token checks.

## Shipping Procedure

### 1. Scope the Change
Before editing, identify the exact layers involved:
1. Migration (`supabase/migrations/`)
2. Database schema contract (`SCHEMA` in `cloudflare/src/db.ts`)
3. Worker service layer (`cloudflare/src/services/`)
4. Route table (`cloudflare/src/api/routes.ts`)
5. API contract + checks (`cloudflare/test/api.itest.mjs`)
6. Frontend client (`src/api.ts` or screen usage)
7. Screen/UI change (`src/pages/` or app UI)
8. Ship flow and deployment pipeline

If the task adds a new table, function, action, endpoint, or column, the change must be implemented across those layers in one push.

### 2. Follow the Project Model
The repo expects this order of implementation:
- Migration first
- `SCHEMA` update
- service logic
- route access rule
- API tests
- frontend call wiring
- screen/UI update
- ship

New business action pattern:
- Add SQL function in a migration
- Expose it in the RPC map
- Add `READ_RPC` or write logic if applicable
- Add access checks and tests

New table pattern:
- Add migration with RLS enabled
- Add policy checks using project authorization helpers
- Add `READ` / `WRITE` rules in `cloudflare/src/services/data.ts`
- Add `SCHEMA` entries for Worker SQL use
- Add the screen and any related frontend integration

### 3. Validate Before Shipping
Run the repo’s checks in order:

1. `cd cloudflare && npx tsc --noEmit && npm test && npm run rehearse`
2. At the repo root:
   - `npx tsc --noEmit`
   - `npm run build`
   - `node scripts/check-api.mjs`
   - `node scripts/lint.mjs`

This is the required pre-ship gate in this repo.

### 4. Ship Safely
Use the standard shipping path:
- `SHIP.bat`
- or `node scripts/ship.mjs "what changed"`

The project’s pipeline is ordered and must be observed as a single queue; pushes never run in parallel.

## Production Pipeline
The repo enforces this ship sequence for pushes to `main`:

1. `guard`
2. `lint` (migrations, placeholders, security gate)
3a. local Supabase DB created from all migrations
3b. API typecheck + unit tests
3c. rehearsal on the real Worker against local DB + stand-in JWKS
   - schema checks
   - 401 for missing / forged / expired token
   - API checks
   - contract updates into `docs/openapi.json`
3d. frontend checks against contract, typecheck, build
4. Supabase DB push
5. Hyperdrive config + one Worker deploy (frontend + API)
6. smoke test
7. record deployment

A push is only production-valid if steps 1–3 pass.

## Required Implementation Patterns

### Database and migration rules
- Migrations are the only DB migrator; do not hand-edit production schema.
- Use naming like `YYYYMMDDHHMMSS_snake_name.sql`.
- Keep migrations non-empty and idempotent.
- Add `[contract]` in the commit message only for later destructive changes after old references are retired.
- RLS must be enabled on tables and policies must follow project authorization helpers such as `me_ws()`, `has_role()`, and `app_uid()`.

### API route rules
- Every endpoint is defined as a single route entry in `cloudflare/src/api/routes.ts` with an explicit `access` policy.
- `public` is only for health/version-style routes.
- Login-only routes are limited to the authenticated-me route.
- Unknown paths without login must 401.
- Add API checks in `cloudflare/test/api.itest.mjs` for every endpoint and permission role.
- If a route is added or changed, update `src/api.ts` to match it.

### Frontend rules
- The frontend calls the backend only via `src/api.ts`.
- Never call `fetch('/api...')` directly from screens.
- If the UI change is small, Claude can implement it directly.
- If it is a larger screen or major frontend work, hand off to AI Studio with the project footer and repo contract details.
- Always check changed frontend files for banned “vibe-coded” patterns and remove them from new or edited code.

### Security and data rules
- The Worker is the security boundary.
- Supabase auth tokens are verified using ES256/JWKS in the Worker.
- Never store secrets in git, chat logs, or frontend code.
- Keep sensitive fields out of audit logs.
- Use `asUser`/`readAsUser` for user-scoped access and `asSystem` only for server/webhook/cron work.

## Decision Points
- If a task changes a migration and the API or UI also uses it, do all layers in the same ship.
- If a rename is needed, do a two-push migration: add the new field and keep the old one usable; only later remove the old contract field.
- If a task is truly large UI work or a new screen, use the AI Studio prompt footer and keep the backend contract in view.
- If a route is a legitimate public business path, it must still be explicitly allowed and tested; the lint gate will reject missing access rules or weakened token checks.
- If a deployment fails, fix the failing step, then re-ship; do not silently skip critical gates.

## Failure Handling
Use the repo’s troubleshooting flow when a ship fails:
- Read the failing GitHub Action log (`gh run view --log-failed`)
- Fix the exact root cause
- Re-run the ship
- Stop after the repo’s stated attempts if the cause remains external or unresolved

Common failure patterns:
- Missing or invalid migration naming
- New code referencing columns not created by migration
- API routes missing from `src/api.ts` or Worker contract
- `supabase db push` conflicts with production data
- Cloudflare token missing Hyperdrive permissions
- Worker deploys failing because of a stale process or stale JWKS state
- Production app cannot reach the database because Hyperdrive config is missing or wrong

## Completion Checklist
A change is ready to ship when all of these are true:
- The migrations, code, routes, contract, frontend usage, and screens are all aligned.
- All required repo checks pass.
- The route access and auth checks are explicit and tested.
- The schema and API docs match the actual implementation.
- The change has been shipped with the normal repo pipeline or the user has been told to run `SHIP.bat`.

## Example Prompts
- "Add a new patient status field and show it on the case detail screen"
- "Create a new API route for the approval flow and validate role access"
- "Ship a new migration + route + screen change with the repo’s required checks"
- "Diagnose why the latest ship failed at step 3c or 5"

## Related Customizations
- Create a project-specific instruction file for route and migration rules if you want these constraints to apply across the repo.
- Create a narrower prompt for frontend-only UI changes if the team wants a lighter AI Studio workflow.
- Add a rollback or incident-response skill if the team wants a separate path for bad deploys.
