-- Separate live checkpoints from the final AI transcript. Existing calls RLS, grants and change triggers apply.
alter table calls add column if not exists live_transcript text;
alter table calls add column if not exists live_transcript_started_at timestamptz;
alter table calls add column if not exists live_transcript_completed_at timestamptz;

-- Preserve every existing v_calls column in its original order, and keep invoker security and phone masking.
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
  cl.ai_status, cl.ai_error, cl.ai_attempts, cl.ai_started_at,
  cl.live_transcript, cl.live_transcript_completed_at,
  (nullif(cl.live_transcript, '') is not null and cl.live_transcript_completed_at is not null) as has_live_transcript
from calls cl
left join workspaces w on w.id = cl.workspace_id
left join profiles pr on pr.id = cl.agent_id
left join patients p on p.id = cl.patient_id
left join cases c on c.id = cl.case_id;

grant select on v_calls to caredesk_app;
