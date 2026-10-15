# Book My Medicare: HHCS-side integration contract

Status: HHCS-side lead/progress API prepared, disabled by default. The user authorized deployment/publication on 15 October 2026, lifting the earlier deployment hold. Activation still requires BMM's actual interface documentation and contract confirmation. This defines an HHCS interface for BMM to confirm; it does not assert compatibility with BMM's existing software. No outbound request is made to an invented BMM endpoint. The complete proposed logic and remaining implementation work are in [BMM-CONNECTION-DESIGN.md](BMM-CONNECTION-DESIGN.md); publishing that design does not implement its extensions.

## Human portal

The human Medicare portal and assigned field-work lifecycle are described in [PROVIDER-FULFILMENT.md](PROVIDER-FULFILMENT.md). They operate through ordinary staff logins independently of the disabled-by-default machine API. Resource quantities, recipient handover, returns and live oversight are supported in that portal. The proposed external-system contract still requires BMM documentation.

## Connection and activation

An administrator creates a dedicated `provider` login assigned to Book My Medicare in Settings > Users. BMM's server signs in through the project's Supabase Auth service and uses the returned access token in `Authorization: Bearer <access_token>` on the endpoints below. Refresh expiring tokens through Supabase Auth. Credentials belong on BMM's server, never in frontend code, logs or chat. Existing ES256 verification and database role checks apply to every request.

Settings > Telephony & integrations > Book My Medicare integration shows provider readiness. A supervisor/admin must confirm BMM accepts this format and enable access. Every workspace starts disabled. Disabling immediately blocks new partner API requests; ordinary provider portal and Excel workflows continue. Do not activate until BMM reviews its auth, field mapping and update sequence.

## Retrieve assigned leads

`GET /api/v1/bmm/leads?limit=50&offset=0`

`limit`: 1–100, default 50. `offset`: nonnegative integer, default 0, maximum 1,000,000. Response: `{total, limit, offset, leads}`. Full polling snapshot ordered by referral creation and ID; advance offset by limit until the total is reached. Periodically restart from offset zero to observe changes. There is no delta-sync guarantee; case/patient edits can happen without a referral timestamp change.

Each released lead includes referral ID, case ID/number, status, status times, progress note, patient name/mobile/address/pincode, branch, hospital, discharge date, plan length, and only BMM's included service lines with quantities and units: a line whose provider was chosen on the case goes only to that provider; category routing applies only to lines with no provider chosen; the unit is the one agreed on the case line (rate-card unit only for older lines). No pricing, calls, recordings, general clinical notes or hospital validation is returned. Cancelled cases/referrals and post-discharge cases awaiting/requiring new sign-off return ID-only `cancelled` or `on_hold` records. Do not fulfil a held/cancelled lead. This cancellation visibility is intentionally scoped to the provider's own referrals.

## Send progress

`POST /api/v1/bmm/leads/{referral_id}/status`

```json
{
  "event_id": "90260313-c1ab-41ae-bbcf-7b325c9f42c1",
  "expected_status": "new",
  "status": "accepted",
  "note": "Lead accepted"
}
```

Use a new UUID event ID for each new action; retry an uncertain request with exactly the same ID and body. A duplicate succeeds without repeating timeline entries, notifications or closure. Reusing an ID with different data returns 409. `expected_status` must match the current lead; stale requests return 409 without changing anything. Fetch the latest lead before creating a revised event.

Allowed transitions match the provider screen: new → accepted/declined; accepted → scheduled/declined; scheduled → scheduled/dispatched/deployed; dispatched → deployed; deployed → completed. `deployed` is accepted as an alias for stored `in_progress`. Scheduling requires `scheduled_at` as an ISO timestamp with explicit timezone, e.g. `2026-10-16T10:00:00+05:30`. Declining requires a reason in `note` (maximum 2,000 characters). Provider requests cannot reopen, cancel or move backward. Existing `update_referral()` writes progress, meets SLAs, notifies operations, and closes BMM-only cases when their work is complete.

Response: `{referral_id, event_id, applied_status, status, duplicate}`. On an old duplicate, applied_status describes that event; status describes the current lead. A failed validation rolls back both the event and status mutation, so a corrected request can reuse the event ID if nothing was applied.

401: missing/invalid/expired token. 403: non-provider or non-BMM login. 400: disabled connection, bad input, missing lead, missing sign-off, or invalid workflow step. 409: stale status or conflicting event ID. No user data is returned by configuration endpoints to an admin.

## Required from BMM before connection

Obtain documentation for supported auth, lead identifiers/fields, status names, timestamps, polling frequency and retry behavior. Confirm whether BMM can call this API. If it instead requires HHCS to push into its API, build that adapter after the real endpoint/auth contract is supplied. Agree how scheduled shifts and equipment-resource updates map to existing partner deployments; this first slice synchronizes leads and lead progress, not individual resource work orders.
