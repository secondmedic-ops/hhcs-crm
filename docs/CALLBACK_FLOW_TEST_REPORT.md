# CareDesk Telephony QA Automation: Callback Flow Simulation Report

**Generated:** 2026-10-19T10:45:26.538Z  
**Duration:** 4.80s  
**Suite:** 10-Step Canonical Telephony Verification Suite ([docs/CALLBACKS.md](file:///c:/Users/DELL/Documents/hhcs-crm/docs/CALLBACKS.md#L33-L51))  
**Result:** ✅ **ALL ASSERTIONS PASSED** (71/71 assertions passed)  

---

## Executive Summary

| Step # | Verification Step | Assertions | Status | Execution Time |
| :---: | :--- | :---: | :---: | :---: |
| **Step 1** | Confirm required MyOperator settings, initial delay, window & Agent-first campaign | 5/5 | ✅ PASS | 18ms |
| **Step 2** | Confirm minute scheduler, webhook deliveries and storage ingress | 3/3 | ✅ PASS | 24ms |
| **Step 3** | Mark test agent Available in CRM and verify MyOperator linkage | 4/4 | ✅ PASS | 17ms |
| **Step 4** | Simulate missed inbound call and abandoned call via mock MyOperator webhooks | 6/6 | ✅ PASS | 132ms |
| **Step 5** | Verify exactly one callback per eligible original call and repeated webhook deduplication | 4/4 | ✅ PASS | 9ms |
| **Step 6** | Verify queue creation with initial delay, eligible_at calculation, and deadline | 7/7 | ✅ PASS | 22ms |
| **Step 7** | Trigger cron sweep (autodial_claim) and select free available agent | 12/12 | ✅ PASS | 28ms |
| **Step 8** | Simulate agent-first answer and verify callback is NOT marked Reached | 6/6 | ✅ PASS | 33ms |
| **Step 9** | Simulate customer leg answer and verify transition to Reached | 7/7 | ✅ PASS | 70ms |
| **Step 10** | Complete conversation (>=20s), close callback with outcome Resolved, test capacity edge cases & teardown | 17/17 | ✅ PASS | 104ms |

---

## Detailed Telephony Lifecycle Flow (Mermaid)

```mermaid
sequenceDiagram
    autonumber
    participant C as Customer / Patient
    participant MO as MyOperator Vendor
    participant CRM as CareDesk Worker / DB
    participant AG as CareDesk Agent (mo-a07)

    Note over C,CRM: Step 4: Missed Call Ingestion
    C->>MO: Inbound Call (+918049368621)
    MO-->>C: Ringing (25s, unanswered)
    MO->>CRM: Webhook call.end (status: missed)
    CRM->>CRM: Insert callback (pending, initial_delay: +30m)
    CRM->>CRM: Start SLA Timer (missed_callback, running)

    Note over CRM,AG: Step 7: Scheduler Sweep & Auto-Dial
    CRM->>CRM: autodial_claim() at eligible_at
    CRM->>AG: Lock available agent (A-07 / mo-a07)
    CRM->>MO: Click-to-call OBD request
    CRM->>CRM: Status -> in_progress, attempt = 1

    Note over MO,CRM: Step 8: Agent-First Answer
    MO->>AG: Ring Agent Leg
    AG-->>MO: Agent Answers (ANSWER)
    MO->>CRM: Webhook call.answered (leg: agent only)
    CRM->>CRM: Call -> answered; Callback STAYS in_progress (NOT Reached)

    Note over C,CRM: Step 9: Customer Leg Answer & SLA Met
    MO->>C: Bridge & Ring Customer Leg (+919811199991)
    C-->>MO: Customer Answers (ANSWER)
    MO->>CRM: Webhook call.answered (legs: agent + customer)
    CRM->>CRM: callback_connected(); Status -> reached
    CRM->>CRM: SLA Timer -> met; pending count drops live

    Note over C,AG: Step 10: Call End & Outcome Closure
    C->>AG: Conversation (>20s duration)
    MO->>CRM: Webhook call.end (completed, talk: 95s)
    CRM->>CRM: callback_call_ended(); Status STAYS reached
    AG->>CRM: callback_close(id, outcome: "resolved")
    CRM->>CRM: Status -> done, outcome -> resolved, interaction logged
```

---

## Step-by-Step Assertion Breakdown

### Step 1: Confirm required MyOperator settings, initial delay, window & Agent-first campaign
*Validates workspace autodial configuration, initial delay settings, buffer window, and campaign rules.*  

- ✅ Autodialer is enabled on workspace
- ✅ Initial callback delay configured to 30 minutes
- ✅ Retry/callback window configured to 30 minutes
- ✅ Maximum dial attempts set to 3
- ✅ Hinduja helpline DID (+918049368621) registered in workspace settings

### Step 2: Confirm minute scheduler, webhook deliveries and storage ingress
*Validates webhook_events storage, idempotent unique constraints, and autodial_claim readiness.*  

- ✅ webhook_events table exists with append-only log
- ✅ autodial_claim() executes successfully under service role
- ✅ Agent role is blocked from executing system autodial_claim()

### Step 3: Mark test agent Available in CRM and verify MyOperator linkage
*Ensures test agent A-07 is active, linked to vendor user ID mo-a07, and marked Available.*  

- ✅ Test agent marked Available in CRM
- ✅ Test agent linked to MyOperator user ID mo-a07
- ✅ Test agent has valid operational role
- ✅ Test agent has 0 active ringing/answered calls (ready for selection)

### Step 4: Simulate missed inbound call and abandoned call via mock MyOperator webhooks
*Delivers inbound call events resulting in missed status with ring duration, followed by abandoned call.*  

- ✅ Missed call.initiated webhook processed and stored
- ✅ Missed call.end webhook processed and stored
- ✅ Call recorded with status missed
- ✅ Call customer_number matches normalized caller
- ✅ Call ring_seconds recorded accurately (25s)
- ✅ Abandoned inbound call categorized as abandoned

### Step 5: Verify exactly one callback per eligible original call and repeated webhook deduplication
*Replays exact same webhook event and ensures duplicate is ignored without creating duplicate callbacks.*  

- ✅ Duplicate webhook event skipped via idempotency check
- ✅ Exactly ONE callback created for +919811199991 (found: 1)
- ✅ Callback reason correctly set to missed
- ✅ Callback linked to origin missed call ID

### Step 6: Verify queue creation with initial delay, eligible_at calculation, and deadline
*Validates eligible_at = origin call ended_at + 30m initial delay, due_at deadline, and SLA timer.*  

- ✅ Callback status is pending in queue
- ✅ Initial attempts count is 0
- ✅ origin_call_at anchored to original call ended_at
- ✅ eligible_at is exactly 30 minutes after original call end (diff: 30m)
- ✅ due_at deadline is anchored to eligible_at + 30m window (window: 30m)
- ✅ missed_callback SLA timer running
- ✅ Callback is NOT dialled before eligible_at has arrived (initial delay respected)

### Step 7: Trigger cron sweep (autodial_claim) and select free available agent
*Runs the scheduler sweep: pairs eligible callback with free Available agent mo-a07 and creates outbound call.*  

- ✅ Auto-dialer claimed eligible callback
- ✅ Claimed agent matches free Available test agent (A-07)
- ✅ Claimed MyOperator user ID matches mo-a07
- ✅ Outbound target matches customer number
- ✅ Callback transitioned to in_progress status
- ✅ Callback attempts count incremented to 1
- ✅ Callback assigned_to set to test agent
- ✅ Callback marked auto_dialled = true
- ✅ Outbound call record created
- ✅ Outbound call starts in ringing state
- ✅ Outbound call links back to callback ID
- ✅ Outbound call has correlation click_to_call_ref

### Step 8: Simulate agent-first answer and verify callback is NOT marked Reached
*Agent phone answers first in bridged campaign; verifies callback remains in_progress until customer connects.*  

- ✅ Agent-first answer webhook processed
- ✅ Call row status updated to answered upon agent pickup
- ✅ CRITICAL: Callback remains in_progress (NOT Reached)
- ✅ CRITICAL: reached_at is still NULL
- ✅ CRITICAL: reached_call_id is still NULL
- ✅ SLA timer remains running (customer not yet connected)

### Step 9: Simulate customer leg answer and verify transition to Reached
*Customer picks up the bridged leg; callback moves to Reached, SLA met, and pending count drops.*  

- ✅ Customer leg answer webhook processed
- ✅ Callback transitioned to reached status
- ✅ reached_at timestamp populated
- ✅ reached_call_id points to outbound call ID
- ✅ completed_at remains null (awaiting closing outcome)
- ✅ missed_callback SLA timer marked MET upon customer connection
- ✅ Dashboard pending callbacks KPI decremented (2 -> 1)

### Step 10: Complete conversation (>=20s), close callback with outcome Resolved, test capacity edge cases & teardown
*Concludes talk time > 20s, records resolved outcome via callback_close, validates capacity isolation and restores settings.*  

- ✅ Outbound call status completed
- ✅ Outbound call customer talk_seconds recorded as 95s
- ✅ Callback stays in reached state after 95s call (waiting for outcome)
- ✅ callback_close rejects invalid outcome without specific choice
- ✅ callback_close rejects follow_up outcome without notes
- ✅ Callback closed with status done
- ✅ Callback outcome recorded as resolved
- ✅ Final callback status in DB is done
- ✅ Final outcome is resolved
- ✅ Outcome note persisted
- ✅ completed_by matches agent user ID
- ✅ completed_at timestamp recorded
- ✅ Double-closing an already resolved callback is blocked
- ✅ Short call (6s) returns callback to pending for retry
- ✅ Callback status reverted to pending after < 20s drop-off
- ✅ Expired callback with 0 attempts transitions to agent_unavailable (capacity exhaustion)
- ✅ Test agent availability reset to false (cleanup)
