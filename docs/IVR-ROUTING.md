# Hinduja inbound calling flow

Implemented: the CRM input-node adapter, workspace settings, IST routing policy and callback capture.
Deployment does **not** publish or activate a MyOperator flow. The adapter defaults disabled and returns 503 until every real node ID and flow ID is saved and enabled in Settings > Telephony & integrations > Hinduja inbound IVR.

## Policy

Every day, 08:00 inclusive to 20:00 exclusive in Asia/Kolkata is office time. No holidays/weekends were specified.

| Step | Selection / condition | Destination |
|---|---|---|
| Office main menu | 1 | Information department |
| Office main menu | 2 | Billing department |
| Office main menu | 5 | Check CSE availability, route to SecondMedic homecare or hold |
| Homecare queue | Free CSE | Homecare department |
| Homecare queue | Busy, elapsed < 180 seconds | Hold music/message, then recheck |
| Homecare queue | Busy, elapsed >= 180 seconds | Callback offer |
| Callback offer | 1 | Register callback, confirmation/SMS node, disconnect |
| Callback offer | 2 | Record voicemail, disconnect |
| After-hours menu | 1 | On-call emergency team |
| After-hours menu | 2 | Register callback for next 08:00 office opening, confirmation/SMS node, disconnect |
| Either input menu | Invalid/no input | Replay twice, then voicemail |

The supplied diagram labels callback-offer option 2 “continue waiting”, but its arrow goes to voicemail. This implementation follows the arrow. Record the prompt as **“Press 1 to request a callback. Press 2 to leave a voicemail.”** Do not publish a prompt promising continued waiting while routing to voicemail.

Suggested after-hours prompt: “Our office is closed. Our working hours are 8 AM to 8 PM. For urgent enquiries, press 1 to reach the on-call team. To request a callback when our office opens, press 2.” This connects to the configured on-call team, not a public emergency service.

## MyOperator setup and activation

The existing OBD click-to-call API is not a tool for publishing an inbound IVR. Use MyOperator's native advanced call-flow builder for audio, department transfers, live queue, voicemail and after-call SMS. Keep `/webhooks/myoperator` for normal call events; input-node decisions use a **separate** URL `/webhooks/myoperator/ivr`.

1. In the actual MyOperator account create the main menu, after-hours menu, Information, Billing, SecondMedic Homecare, on-call emergency, hold loop, callback offer, callback confirmation and voicemail nodes. Link the departments to the real users/on-call rota. Verify the emergency destination and configure provider-side failover if it does not answer.
2. Configure the input-node HTTP request mapping below. The response is the **CareDesk adapter contract**; the account's response mapping must consume `flow_id` and `target_node_id`. Confirm the account supports that mapping (and a short input-node response deadline) with MyOperator. No undocumented provider API or provider publishing operation is assumed here.
3. Hold loops must send a new `queue` decision request on each recheck, for example every 15 seconds. A failed/busy homecare transfer must return to that queue decision, retaining the same provider session ID. MyOperator owns the final agent reservation and phone availability; CRM availability is only advisory.
4. Make a provider-side timeout/HTTP-error/withheld-number fallback to voicemail. A failure reaching the CRM must not strand a caller. Set input-node request deadlines to the account's limit; measure actual latency on the production account before activation. Do not replace the live flow until a test flow passes.
5. Create an approved SMS template/after-call rule in MyOperator for the callback confirmation path, deduplicated by provider call/session ID. SMS must be sent only when registration succeeded. The CRM returns `sms_status: "provider_pending"`, never “sent”. Configure the confirmation node to play the acknowledgement and disconnect gracefully even if SMS delivery fails. SMS delivery and voicemail recording remain provider operations.
6. Save the actual flow ID and all ten destination node IDs in CareDesk. Enable the adapter only after testing the request/response mapping. Publish the verified MyOperator flow through that account's normal publishing controls.
7. Test office and after-hours routes, CSE answered/busy/no-answer, the exact three-minute boundary, invalid/no input, hidden caller ID, duplicate delivery, callback creation, SMS receipt and voicemail recording. A successful software deploy alone does not prove live phone routing.

## Input-node request contract

POST JSON to `https://hhcs-caredesk.secondmedichost.workers.dev/webhooks/myoperator/ivr`.
Authenticate with `x-webhook-key: <the saved MyOperator webhook key>`. The key stays in the provider configuration; never include it in a URL or browser bundle.

```json
{
  "session_id": "provider-session-id",
  "request_id": "unique-node-execution-id",
  "customer_number": "+919800000001",
  "did_number": "+918049368621",
  "step": "entry",
  "digit": ""
}
```

`session_id` must be the exact same session identifier as normal call events. `request_id` is unique for each node execution and stable across transport retries. IDs accept letters, numbers, `.`, `_`, `:`, `-`, up to 160 characters. Required `step` is `entry`, `menu`, `after_hours`, `queue`, or `callback_offer`. `digit` is optional for entry/queue and one DTMF character or empty for input menus. The caller number must be callable; hidden numbers receive 400 and must use the provider fallback. DID chooses the matching configured workspace; absent/unmatched DID uses the existing default workspace.

Example response (actual saved IDs replace these example IDs):

```json
{
  "flow_id": "hinduja-flow",
  "target_node_id": "callback-confirm-node",
  "action": "callback_confirm",
  "callback_id": "a-generated-uuid",
  "sms_status": "provider_pending"
}
```

`callback_id` and `sms_status` are null on non-callback responses. Call decisions are serialized with the existing call-session lock and stored in `calls.raw.ivr`. Callbacks use the existing `callbacks` table, `reason=requested`, caller and patient linkage, and the existing callback SLA/auto-dialer. Retried callback requests reuse the same callback. The adapter never disconnects/marks a call finished itself: normal provider end events remain authoritative. Ordinary call events and call-log sync must retain the same session ID.

After-hours callbacks get `next_attempt_at` at the next 08:00 opening if auto-dialling is enabled, and their deadline is opening + the configured auto-dial buffer (otherwise the missed-callback SLA). No automatic callback is attempted overnight by this registration. Staff can still manually call from the queue. No patient data or phone numbers are returned by the settings endpoints.

## References

- [MyOperator Input Nodes and Node IDs](https://myoperator.crisp.help/en/article/how-do-input-nodes-and-node-ids-work-in-myoperator-ivr-and-how-do-i-set-them-up-1n4u27x/)
- [MyOperator IVR node types](https://support.myoperator.com/portal/en/kb/articles/what-are-the-different-types-of-nodes-that-can-be-added-in-an-ivr)
- [MyOperator After-Call SMS](https://support.myoperator.com/portal/en/kb/articles/what-type-of-smss-i-can-send-23-8-2025)

## Deployment

Use the existing `ship` workflow on `main`. Its Wrangler step ships the frontend and API together with the production Hyperdrive binding and secrets. Do not run a competing deploy with the local stand-in Hyperdrive configuration. This change reuses existing tables and requires no migration. Disabling the adapter in settings stops these decisions without changing existing normal call webhooks or outbound calling.
