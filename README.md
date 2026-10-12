# CareDesk CRM · Hinduja Home Care Services × SecondMedic

The patient-service CRM from the Hinduja proposal deck, with MyOperator calling built in. One case ID from enquiry to closure, every call recorded on one patient timeline, a locked rate card with in-app discount approval, live SLA timers, three-level escalation, a live Hinduja dashboard and automated MIS.

**Stack (your standard one):** Supabase (Postgres + Auth) · one Cloudflare Worker on the free plan (TypeScript API + the React app + MyOperator webhooks + cron + inbound email) · GitHub with the SHIP.bat pipeline · MyOperator (IVR, calls, recordings, WhatsApp) · Gemini key from Google AI Studio for the AI features.

## 1. Run it locally (nothing live is touched)

Needs Node 20 or newer.

Double-click **`RUN-LOCAL-TEST.bat`**. Two windows open (API and frontend), then the browser opens http://localhost:3000. The top bar says **LOCAL TEST**: the same Worker code as the live site, on a throw-away database with a week of sample MMR operations. Pick any role on the start screen.

Try: as an agent press **Simulate test call**. It goes to the local Worker as a real MyOperator webhook, the pop-up shows the line (Khar or Mahim), **Answer** and **End call** send the next webhooks, and the call appears on every open screen without a refresh. Open a second browser window as Hinduja management to watch the dashboard move.

No Worker running (for example opening the built site on its own)? The app falls back to an in-browser **DEMO** with the same data.

## 2. Go live (one-time setup, then SHIP.bat)

1. **Supabase:** create a project in **Mumbai (ap-south-1)**. Nothing else to run: the pipeline applies the migrations.
2. **Cloudflare:** an API token from the "Edit Cloudflare Workers" template **plus Account > Hyperdrive > Edit**, and your account ID.
3. **MyOperator:** from the panel's Developer / API section: company ID, secret token, OBD (click-to-call) API key, public IVR ID, API token. Make up a long random webhook key.
4. Double-click **`START-HERE.bat`**. It signs the GitHub CLI in as **secondmedic-ops** (switching away from any other account), pushes the code to the private repository **secondmedic-ops/hhcs-crm** (creating it if needed), and asks for each value above (typed hidden, saved as GitHub secrets, never printed). Enter skips anything you don't have yet; run it again later to add it.
5. Do the browser steps it prints (Supabase JWT keys = ECC, sign-ups off, TOTP on, add your login).
6. Double-click **`SHIP.bat`**. The pipeline checks everything (guard, lint, a fresh database from the migrations, typecheck, the case-workflow test, 60+ API checks on the real Worker, the frontend contract), then applies migrations, deploys the Worker, smoke-tests the live site and prints **LIVE**.
7. Run the SQL it printed in Supabase > SQL Editor (makes you platform admin), log in, then:
   - Settings > Users: add agents (with their **MyOperator user ID**), coordinators, supervisors, field staff, and the Hinduja logins.
   - Settings > Telephony: MyOperator details, webhook key, link agents (section 3).
   - Settings > Rate card, Templates, SLAs, Escalation matrix: load Hinduja's approved values (Hinduja management approves changes in-app).

After that, every change is just **SHIP.bat**.

## CRM calling without a browser extension

All live outbound calls start from CareDesk's authenticated Calling API. Press **Call patient** or **Call back**, answer the linked agent's registered phone, then speak to the customer. No MyOperator browser extension or Webcall window is used.

In Settings > Telephony, save Company ID, Secret token, Calling API key and Public IVR ID, then link each CRM login to its MyOperator user. MyOperator must enable a peer-to-peer user-dial campaign with **Dial first: Agent**, an outgoing business number and sufficient calling capacity/credits. A saved configuration alone does not verify the account's calling entitlement.

The server uses type 1 user dial with the linked user ID and a CRM reference. Credentials and the unmasked customer number stay on the server. Existing saved dial_mode values are ignored; the extension fallback and reset button have been removed.

Missing configuration blocks the attempt before a call record is created. An explicit provider rejection marks the attempt failed and returns a callback to the pending queue. A timeout, provider server error or unrecognised response is unconfirmed: check the phone and Calls list before retrying. CareDesk never automatically repeats a dial request. Webhooks and call-log sync continue to attach results and recordings.

Admin verification: Test connection checks saved settings and user API access without placing a call. Complete a controlled agent-first call to confirm live operation. If Calling API access is disabled or the Public IVR ID was cleared by the former reset action, the administrator must restore it; installing an extension will not be required.

References: [MyOperator API reference](https://support.myoperator.com/portal/en/kb/articles/myoperator-api-reference-postman-documentation-links) and [peer-to-peer Calling API setup](https://support.myoperator.com/portal/en/kb/articles/how-is-the-obd-campaign-different-from-click-o-call-in-myoperator).

## 3. MyOperator settings

Everything is entered in CareDesk itself: **Settings > Telephony & integrations** (platform admin). Nothing to deploy.

| Step | Where |
|---|---|
| Company ID, Secret token, Calling API key, Public IVR ID | MyOperator > APIs & Webhooks > Developer API > Calling API > Manage. Paste into CareDesk, Save. |
| API token (users, call logs, recordings) | MyOperator > Manage > API Integration (or Developer API). Paste, Save, then **Test connection**. |
| Webhook | In CareDesk press **Generate key** and copy the webhook address. In MyOperator > APIs & Webhooks > Calling Webhooks add two: type **InCall** (live pop-up) and type **AfterCall** (call end, recording), POST, JSON, that address. Or, once MyOperator support enables **Webhooks v2**, one v2 webhook with header `x-webhook-key`. |
| Agents | **Load MyOperator users**, then **Link by email / phone** (or pick each login). A linked agent gets the pop-up and can click to call. |
| Helpline | +91 80493 68621 (Hinduja), set as the workspace line. |

Values saved in the app win over the `MYOPERATOR_*` GitHub secrets; clearing one falls back to the secret. Credentials are kept in a table only the Worker's system connection can read, and the screen only ever gets their last 4 characters. The event log on the same page shows every call event with its raw content, so the first real test call can be checked field by field.

## Service providers (lead assignment)

Every case goes to its provider by its services: **SecondMedic** (ECG, X-ray, blood tests) and **Book My Medicare** (nursing, physiotherapy, hospital beds, elder care, other home care). A mixed case goes to both. The provider sees the case ID, patient details, address and requirements on **Provider leads**, never call recordings. Book My Medicare staff log in with the role *Service provider* (Settings > Users, pick the provider) and accept, schedule, start and complete their leads, adding progress notes; a case served only by Book My Medicare closes when its lead is completed. SecondMedic's lead follows the normal case stages. Call centre agents choose the Hinduja branch (Khar / Mahim) on every enquiry. **Settings > Import from old CRM** brings in the previous Hinduja CRM from Excel or CSV.

## What is in it

| # | Hinduja requirement (deck slides 3-4) | Where |
|---|---|---|
| 1 | Dedicated number, email, chat in one CRM; live visibility | MyOperator lines with labels, inbound email, WhatsApp; Hinduja logins |
| 2 | Capture every interaction | One timeline per patient, written by webhooks, email and the app |
| 3 | Record inbound + outbound calls | MyOperator recordings, played through the Worker, every play logged |
| 4 | Unique case ID through all stages | `HHC-YYMMDD-NNNNN`, stage gates enforced in the database |
| 5 | Live dashboard with drill-down | Calls, SLA, funnel, operations, geography, money, quality, escalations |
| 6 | Daily / weekly / monthly MIS | Generated at 10:00 IST, Excel / PDF export, optional e-mail and AI summary |
| 7 | Defined TATs | SLA policies and timers, checked every minute, breaches escalate |
| 8, 9 | Only approved prices, scripts, templates | No free-text price; discount above band waits for Hinduja approval; versioned, approved templates |
| 10 | Immediate escalation | Three-level matrix; critical lab values and AI-flagged calls raise clinical escalations |
| 11, 12, 15 | Data is Hinduja's; purpose limitation; exit | Separate workspace, audit and access logs, one-click full export, exit checklist |
| 13 | Consent, RBAC, security | Consent log, 8 roles enforced in the Worker and the database, masked numbers for agents, TOTP, idle sign-out, data in Mumbai |
| 14 | Supervisor governance | QA scores on recorded calls, coaching notes, SLA views |

## Security in one paragraph

Every `/api` call needs a Supabase login, verified in the Worker (ES256 keys, issuer, audience). The Worker checks the endpoint's roles and each table or action against its role rules, then runs the query **as the database role `caredesk_app` with your user id set**, so the database's own Row Level Security and the checks inside every business function apply too. Supabase's public Data API and Realtime get no access at all. Screens send a description of the query, never SQL; names are validated and values are parameters. MyOperator webhooks need the shared key; secrets live only in GitHub and the Worker.

## Folder map

`src/` React app (screens) · `src/api.ts` the only file that calls the API · `cloudflare/` the Worker (`src/api`, `src/services`, `src/domain`, `test/`) · `supabase/migrations/` the database · `scripts/` pipeline · `.github/workflows/ship.yml` the pipeline · `docs/` generated contract and schema, screen guide · `PROJECT.md` project values and rules · `CLAUDE.md` notes for changes.
