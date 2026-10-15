# Missed-call callbacks: behavior and live verification

## Timing and settings

Settings > Telephony & integrations > Callback auto-dialer controls on/off, a 30/45/60-minute callback/retry window and 1–5 maximum attempts. The existing scheduler checks once per minute. Eligibility starts immediately; an attempt starts on a scheduler run when an eligible agent is free. This is not an initial delay or a guarantee of connection within the window.

The deadline remains anchored to callback creation, not the original call. For example, a missed call at 09:55 imported at 10:00 creates a callback eligible at 10:00. With a 30-minute window and three attempts, its deadline is 10:30. If the first attempt starts at 10:01 and fails, the next eligibility is 10:11, then 10:21 if that attempt also fails. Actual starts can be later. Spacing remains `max(2 minutes, configured window / maximum attempts)` from the last attempt start. No new automatic attempt starts at or after 10:30; an active call is not disconnected at the deadline. Attempt exhaustion, or a calculated next attempt at/after the deadline, keeps the existing Unreachable closure policy.

## Agent and connection rules

Automatic selection retains the existing operational roles: agent, coordinator, supervisor. The account must be active, in the callback workspace, marked Available, have a nonblank MyOperator link and have no ringing/answered call or outstanding callback reservation. The least recently auto-dialled eligible agent is selected first. Manual calls share the profile reservation lock with automatic calls. A long answered call never becomes free merely because 30 minutes passed.

Calling remains in the CRM backend through the existing peer-to-peer user-dial API. The linked MyOperator campaign must be configured to ring the agent first and bridge the customer after the agent answers. The CRM cannot verify that campaign setting or reliable live vendor busy state from the existing integration. CRM Available is a routing preference, separate from vendor availability. A rejected or busy request is handled safely without a browser extension or number reveal.

MyOperator documents that a call.answered event can describe either leg. Outbound callbacks require customer-leg evidence (type/phone plus answered status/time/talk), or a correlated final answered call log; an agent-only answer and an accepted API request are not proof of reaching the customer. NOANSWER is not ANSWER. Uncorrelated same-number logs cannot adopt a CRM outbound reservation. Session, provider ID and correlation matches are workspace scoped. If actual customer answer time is unavailable, a final successful log uses the call end as the conservative reach time, rather than pretending the call start was the answer time.

## Queue, outcomes and recovery

Missed/abandoned inbound events create callbacks. Queue insertion is serialized by workspace and normalized number; repeat delivery of the same original call cannot recreate its callback after closure. A genuinely later missed call can create another follow-up.

Callback queue > Pending includes waiting and dialling items, attempts, eligibility and deadline. Customer connection moves the callback to Reached under Needs outcome and meets the callback SLA. Only its latest linked outbound attempt can reach or retry it. Done still requires an authorized closing outcome: Resolved, Follow-up needed, Wrong number, No longer needed. Follow-up needs a note. MIS distinguishes reaching the customer from recording an outcome. A completed conversation under 20 seconds returns to retry and reopens the SLA; exactly 20 seconds and missing talk time preserve the existing successful-completion rule.

Explicit provider rejection retries only if the call is still ringing. A timeout/uncertain response retains the correlation reference and reservation; it is not immediately redialled. Five minutes alone no longer converts an unresolved ringing call to failure. Existing call-log sync runs before the dialer. Its existing three-hour stale-ringing recovery can close a call when no log was found, with an unconfirmed-outcome reason; answered calls remain active. Terminal calls with a stuck callback can then recover through the existing retry process. Since callback windows are at most 60 minutes, a three-hour unresolved automatic attempt cannot start another automatic attempt in that window. If sync is unavailable, the reservation remains for investigation instead of risking a duplicate call.

Missing calling configuration leaves callbacks pending without creating a call. The queue and settings show that reason. Expiry without an eligible agent retains Unreachable under the existing policy, with a reason explicitly saying no customer attempt was made. Neither state establishes that the customer was unreachable. Whether these cases should get a separate status is a future business decision; this change does not introduce one.

## Local verification

All tests use disposable data or vendor stand-ins. The backend suite covers the real migration chain, role/workspace isolation, all three windows and all five attempt limits, spacing/deadline boundaries, Away/inactive/unlinked/ineligible agents, long calls, repeated claims, fair selection, stale-attempt linkage, short-call recovery, missing talk time, outcomes, SLA and MIS. Transport tests distinguish explicit rejection from uncertainty and verify missing configuration makes no claim or provider request.

The real Worker rehearsal also checks concurrent manual claims, duplicate inbound deliveries, later follow-ups, agent-only answers, customer NOANSWER, unrelated same-number logs, real API permissions, cron initiation and readiness reporting through direct and batched screen reads. Project-required backend/frontend type checks, frontend build, API contract validation and lint accompany these checks. These checks do not prove live telephony works.

## Live verification: pending an authorized test number and vendor access

No live test call is authorized by the deployment request. Use an agreed test number, never a real patient, and record timestamp, callback ID, call ID and correlation reference without publishing phone numbers or credentials.

1. Confirm required MyOperator settings, calling credits/access, the agent link and the campaign's Agent-first setting.
2. Confirm the minute scheduler, webhook deliveries and call-log sync are working.
3. Mark a test agent Available in CRM and available in MyOperator.
4. Generate a controlled missed inbound call and repeat with an abandoned call.
5. Verify exactly one callback for each eligible original call, including repeated webhook/log delivery.
6. Confirm first eligibility at queue creation and an attempt on an eligible scheduler run, without waiting for the full window.
7. Observe the agent phone ringing before customer connection. Agent answer alone must not mark Reached.
8. Confirm customer connection moves to Reached/Needs outcome, removes the pending count, and a recorded outcome alone marks Done.
9. Test Away/busy/no eligible agent and a failed customer connection; verify attempt count, truthful reason, spacing, deadline and no duplicate dial. Check a short call and an uncertain request only with a controlled vendor test setup.
10. Restore all temporary settings/availability and record results separately from local evidence.

Before the next AI Studio session, load the latest GitHub version so its screen edits retain these changes.

Vendor references: [Webhook event semantics](https://support.myoperator.com/portal/en/kb/articles/how-do-i-configure-and-manage-webhook-in-myoperator), [payload fields and correlation](https://support.myoperator.com/portal/en/kb/articles/what-is-the-exact-payload-structure-for-every-myoperator-webhook-v2-event).
