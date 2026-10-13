-- The old after-call fallback treated _ss (UTC seconds since midnight in legacy logs) as talk time.
-- Repair only unsummarised recordings with that exact signature and a provider-confirmed call under two hours.
-- Valid _dr values, already completed summaries, and all other call formats are untouched.
with legacy as (
  select id, talk_seconds as previous_seconds, raw->'end' as ending,
    case when raw->'end'->>'_st' ~ '^[0-9]{10}([0-9]{3})?$'
      then (raw->'end'->>'_st')::numeric / case when length(raw->'end'->>'_st') = 13 then 1000 else 1 end end as start_epoch,
    case when raw->'end'->>'_et' ~ '^[0-9]{10}([0-9]{3})?$'
      then (raw->'end'->>'_et')::numeric / case when length(raw->'end'->>'_et') = 13 then 1000 else 1 end end as end_epoch,
    case when raw->'end'->>'_ss' ~ '^[0-9]{1,5}$' then (raw->'end'->>'_ss')::int end as clock_seconds,
    case when raw->'end'->>'_drs' ~ '^[0-9]{1,9}$' then (raw->'end'->>'_drs')::int end as duration_seconds
  from calls
  where provider = 'myoperator' and status = 'completed' and recording_filename is not null
    and ai_processed_at is null and nullif(ai_summary, '') is null and ai_status is distinct from 'done'
    and talk_seconds > 7200 and raw->'end'->>'_su' = '1' and nullif(raw->'end'->>'_dr', '') is null
), durations as (
  select id, previous_seconds,
    case when duration_seconds between 0 and round(end_epoch - start_epoch) + 1 then duration_seconds
      else round(end_epoch - start_epoch)::int end as seconds
  from legacy
  where end_epoch >= start_epoch and end_epoch - start_epoch between 0 and 7200
    and previous_seconds = clock_seconds and clock_seconds = mod(floor(start_epoch), 86400)
    and previous_seconds > greatest(7200, (end_epoch - start_epoch) * 10)
), repaired as (
  update calls c set talk_seconds = d.seconds,
    ai_status = case when c.ai_status = 'skipped' and c.ai_error like 'Over 2 hours of talk time:%'
      and d.seconds between 10 and 7200 then null else c.ai_status end,
    ai_error = case when c.ai_status = 'skipped' and c.ai_error like 'Over 2 hours of talk time:%'
      and d.seconds between 10 and 7200 then null else c.ai_error end
  from durations d where c.id = d.id
  returning c.id, c.talk_seconds, d.previous_seconds
)
update interactions i set evidence = 'Recording ' || (r.talk_seconds / 60)::text || ':' || lpad((r.talk_seconds % 60)::text, 2, '0')
from repaired r
where i.call_id = r.id and i.channel = 'phone'
  and i.evidence = 'Recording ' || (r.previous_seconds / 60)::text || ':' || lpad((r.previous_seconds % 60)::text, 2, '0');
