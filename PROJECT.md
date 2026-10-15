# CareDesk CRM · Hinduja Home Care Services × SecondMedic

Patient-service CRM for the HHCS engagement (proposal deck, Sept 2026): one case ID from enquiry to closure, every call recorded through MyOperator on the patient timeline, locked rate card with in-app discount approval, SLA timers, three-level escalation, live Hinduja dashboard and MIS. It runs on the **sb-spring-cf-stack** pipeline (Worker + Supabase, no Java): one push checks and ships the database, the API and the frontend together, on free plans.

- GitHub repo: secondmedic-ops/hhcs-crm   (`main` = production; pushed only as the GitHub account secondmedic-ops)
- Live URL: https://hhcs-caredesk.secondmedic.workers.dev
- Cloudflare Worker: `hhcs-caredesk` (Workers **Free**), everything in `cloudflare/`. ONE Worker is the whole app: `/api/*` is the backend (TypeScript: `src/api`, `src/services`, `src/domain`), `/webhooks/myoperator` takes MyOperator events, crons run the SLA scan and MIS, `email()` turns mailbox mail into tickets, everything else is the React build `dist/`.
- Hyperdrive config: `hhcs-caredesk-db` (made by the pipeline from the GitHub secret `SUPABASE_DB_URL`, caching off).
- Live updates: Durable Object `LiveHub` (SQLite class, free plan): the Worker pushes changed table names to open screens over WebSocket.
- Supabase project ref: eilshdpbnhcohroujaui   region: ap-south-1   URL: https://eilshdpbnhcohroujaui.supabase.co
- DB pooler host (copy from Supabase > Connect > Session pooler, never guess aws-0/aws-1): (set by START-HERE.bat)   user: postgres.<ref>
- Auth: Supabase Auth with ES256 signing keys, verified in the Worker with `jose` (issuer `<SUPABASE_URL>/auth/v1`, audience `authenticated`). TOTP two-factor is asked at login for users who enrolled it; idle sign-out after 30 minutes (Settings > Workspace).
- Roles (`public.profiles.role`, one per user, set by the platform admin in Settings > Users; cached 60 s):
  - **agent**: contact centre: own queue, enquiries, quotes, callbacks; sees masked phone numbers
  - **coordinator**: all active cases, booking, field assignment, reconciliation
  - **supervisor**: everything operational, recordings, QA, MIS, audit, controlled export
  - **field_staff**: only assigned visits, check-in, samples, payment collection (phone layout)
  - **medical_desk**: clinical triage and escalations
  - **client_manager** (Hinduja management): full visibility, approvals (discounts, rate card, templates), export, data exit
  - **client_clinical** (Hinduja clinical): clinical records, escalations, MIS
  - **admin** (SecondMedic platform admin): configuration and users only, sees no patient data
  - **administrator** (SecondMedic administrator): full access. Everything a supervisor, Hinduja management and the platform admin can do, with full phone numbers; creates staff logins of any role and opens staff workspaces. In the database `has_role()` lets an administrator pass any check that names a senior role (supervisor, client roles, coordinator, medical desk), but not the agent / field staff / partner / platform-admin rules that narrow what one person sees; the Worker (`allows()` in `api/auth.ts`) and the screens (`roleAllows()` in `src/lib/auth.jsx`) use the same rule. The first one is created with the `create-login` GitHub Action (secret `NEW_LOGIN`, deleted after use).
  - **provider** (service-provider staff, e.g. Book My Medicare; `profiles.provider_id` says which): only the cases sent to their provider (Provider leads page): case ID, patient details, requirements; accept / schedule / start / complete / decline, progress notes. Never calls or recordings.
- Providers and lead routing (Hinduja requirements, Oct 2026): table `providers` (SM = SecondMedic: ECG, X-ray, blood tests, visits; BMM = Book My Medicare: nursing, physiotherapy, hospital beds, elder care, other home care) and `case_referrals` (one lead per provider per case). `route_case()` sends each case by its services (or by the request text when no services are added); SecondMedic's lead follows the case stages, an outside provider moves its lead with `update_referral()`, and a case served only by outside providers closes when its leads are done. SecondMedic coordinators see only SecondMedic or not-yet-routed cases. Branch (Khar / Mahim, `workspaces.settings.branches`) and `additional_info` are on every case. `import_cases()` (Settings > Import from old CRM) brings in the previous Hinduja CRM from Excel / CSV; the old ID is `cases.external_ref`.
- Sensitive fields kept out of `audit_log` and logs: patient names, phone numbers, addresses, clinical notes (DPDP Act 2023). Hinduja is the Data Fiduciary; SecondMedic is the Data Processor.
- MyOperator: helpline +91 80493 68621 (account "Hinduja - SecondMedic"). Connection values are entered in Settings > Telephony (table `integration_settings`, system-only; they win over the MYOPERATOR_* secrets). Webhooks accepted: v2, InCall, AfterCall, all at `/webhooks/myoperator` (key in `x-webhook-key`, `?key=` or Basic auth).
- Secrets (GitHub secrets, uploaded to the Worker by the pipeline): `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" **plus Account > Hyperdrive > Edit**), `CLOUDFLARE_ACCOUNT_ID`, `SUPABASE_DB_URL`, `MYOPERATOR_WEBHOOK_KEY`, `MYOPERATOR_COMPANY_ID`, `MYOPERATOR_SECRET_TOKEN`, `MYOPERATOR_OBD_API_KEY`, `MYOPERATOR_PUBLIC_IVR_ID`, `MYOPERATOR_API_TOKEN`, optional `MYOPERATOR_WABA_API_KEY`, `MYOPERATOR_WABA_PHONE_ID`, `MYOPERATOR_CALLER_ID`, `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `MIS_RECIPIENTS`, `MIS_FROM`. GitHub variables: `APP_URL`, `VITE_SUPABASE_URL` (also the Worker's `SUPABASE_URL`), `VITE_SUPABASE_ANON_KEY`.

## Where this project differs from the skill's template (and why)

| Skill template | CareDesk |
|---|---|
| Worker connects as `postgres`; RLS on with **no** policies; all rules in TypeScript | Worker verifies the login and the route's roles, then runs each request **as `caredesk_app` with the user id set** (`app_uid()`), so the Row Level Security policies and the role checks inside the ~25 RPCs (stage gates, pricing lock, discount approval, masking) still apply as a second wall. `anon` / `authenticated` get no grants, so Supabase's public Data API sees nothing. |
| One endpoint per business operation in `routes.ts` | Screens use a query builder: reads go to `POST /api/v1/batch` (one transaction per screen load), writes to `POST /api/v1/data/{table}`, actions to `POST /api/v1/rpc/{fn}`. Who may read / write which table and call which action is in `services/data.ts` (`READ`, `WRITE`, `RPC`), also exported in `docs/openapi.json`. The Worker builds all SQL from a JSON description (`domain/query.ts`); it never accepts SQL text. |
| Roles in `public.user_roles` | Roles in `public.profiles` (with workspace, MyOperator user id, agent code). |
| Frontend in TypeScript, from AI Studio | Frontend in JavaScript (React + Vite), built here; `src/api.ts` is TypeScript and is the only file that calls `/api`. AI Studio may edit screens (`src/pages`, `src/components`, `src/App.jsx`). |
| `server.ts` dev server | Vite dev server on :3000 forwards `/api` (and the live WebSocket) to the local Worker. With no Worker, the app opens an in-browser demo (PGlite with the real migrations). |
| JSON without null fields | Null fields are kept (screens read them). |
| Supabase Realtime | Not used (closed with the Data API). Live updates come from the Worker's `LiveHub` Durable Object. |

## Everyday use

Supervisors can select a department and staff member from the first Live dashboard to open an audited staff workspace for 30 minutes. Actions display `Staff Name - Supervisor (Supervisor Name)` in audit/access records; the original supervisor login is retained. See `docs/SUPERVISOR-STAFF-ACCESS.md`.

AI Summary supports microphone transcription during active calls using `gemini-3.5-transcribe-live` and server-created, single-use ephemeral tokens. Finished live transcripts are summarised by the configured text model; recordings remain the fallback. MyOperator does not currently stream live audio into the CRM: use speakerphone near the microphone. Setup, charges and limits: `docs/AI-LIVE-TRANSCRIPTION.md`.

BMM system access: the HHCS-side authenticated lead/progress API is prepared but **disabled by default**. See `docs/BMM-INTEGRATION.md`. BMM must confirm the contract before activation under Settings > Telephony & integrations > Book My Medicare integration. Deployment of this change is on hold pending BMM documentation; no BMM endpoint or credentials have been assumed.

| You want to | Do this |
|---|---|
| Ship any change | Double-click `SHIP.bat` |
| Test locally without touching live data | Double-click `RUN-LOCAL-TEST.bat` (same Worker code on an in-memory test database with a week of sample data; pick any role; "Simulate test call" sends a real MyOperator webhook to it) |
| Run the API's tests yourself | `cd cloudflare`, `npm test` (workflow + translator) and `npm run rehearse` (the whole API on a throw-away database, 60+ checks) |
| Give someone access | Settings > Users > Add user (platform admin or administrator; needs `SUPABASE_SERVICE_ROLE_KEY`). With nobody to do that: GitHub secret `NEW_LOGIN` = {"full_name","email","password","role"}, run GitHub > Actions > create-login, then delete the secret |
| Replace the Cloudflare key | Double-click `CLOUDFLARE-TOKEN.bat` |
| Roll back | GitHub > Actions > ship > Run workflow: `ref` = the last good `deploy-*` tag, tick `skip_db` |

## Rules for AI Studio

AI Studio edits only screens: `src/App.jsx`, `src/pages/*`, `src/components/*`, `index.html`, `src/styles.css`. It never touches `cloudflare/`, `supabase/`, `scripts/`, `.github/`, `docs/`, `src/api.ts`, `src/lib/`, `src/demo/`, `src/main.jsx` or the `.bat` files; the pipeline's guard blocks the deploy if it does. Screens read data with `db.from(...)` / `rpc(...)` from `src/lib/db.js` (see `docs/DEVGUIDE.md`), never `fetch('/api...')`.
