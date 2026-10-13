-- AI call summaries from the recording (services/ai.ts processCall, run by the webhook, the every-minute cron sweep, or
-- "Summarise" on a call). Each recorded call now carries where its summary stands, so a failure is visible on the screens
-- and is retried instead of being lost in the Worker log:
--   ai_status    null = not tried yet · processing · done · failed (retried by the cron up to 3 attempts) · skipped (too short)
--   ai_error     the last failure, shown to staff (no patient data: download / Gemini error text only)
--   ai_attempts  how many times it was tried
--   ai_started_at when the current or last attempt began (a "processing" older than 10 minutes counts as stuck)
-- The Gemini key, model and on / off switch live in integration_settings ('ai'), entered in Settings (system-only table).
-- Expand only.

alter table calls add column if not exists ai_status text;
alter table calls add column if not exists ai_error text;
alter table calls add column if not exists ai_attempts int not null default 0;
alter table calls add column if not exists ai_started_at timestamptz;
alter table calls drop constraint if exists calls_ai_status_check;
alter table calls add constraint calls_ai_status_check check (ai_status in ('processing','done','failed','skipped'));

-- calls already summarised before this change
update calls set ai_status = 'done' where ai_processed_at is not null and ai_status is null;

-- the cron sweep looks for recorded calls without a summary, newest first
create index if not exists calls_ai_backlog on calls (started_at desc) where recording_filename is not null and ai_processed_at is null;

-- v_calls: same view, four columns added at the end
create or replace view v_calls with (security_invoker = true) as
select cl.id, cl.workspace_id, cl.provider, cl.provider_call_id, cl.session_id, cl.direction,
  case when has_role('agent') then mask_mobile(cl.customer_number) else cl.customer_number end as customer_number,
  cl.did_number, cl.agent_id, coalesce(pr.agent_code || ' · ' || pr.full_name, cl.agent_name) as agent_label,
  cl.department, cl.status, cl.started_at, cl.answered_at, cl.ended_at, cl.ring_seconds, cl.talk_seconds,
  (cl.recording_filename is not null) as has_recording,
  cl.patient_id, cl.case_id, cl.disposition, cl.notes, cl.transcript, cl.ai_summary, cl.ai_sentiment, cl.ai_intent,
  cl.ai_extracted, cl.ai_flags, cl.ai_processed_at,
  p.full_name as patient_name, c.case_no,
  (select q.total_pct from qa_reviews q where q.call_id = cl.id order by q.created_at desc limit 1) as qa_pct,
  coalesce(w.settings->'did_labels'->>cl.did_number, case when cl.did_number is null then null else 'Main line' end) as line_label,
  cl.ai_status, cl.ai_error, cl.ai_attempts, cl.ai_started_at
from calls cl
left join workspaces w on w.id = cl.workspace_id
left join profiles pr on pr.id = cl.agent_id
left join patients p on p.id = cl.patient_id
left join cases c on c.id = cl.case_id;

grant select on v_calls to caredesk_app;
