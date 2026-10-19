-- =====================================================================
-- CareDesk CRM  |  Call timing integrity (negative and missing durations)
-- Root cause: answered_at came from the Worker's clock when the in-call webhook arrived (new Date()), while
--   ended_at came from MyOperator's clock. A webhook that arrives a few seconds late puts answered_at after ended_at
--   (-2 s, -9 s). v2 call.end with no talk_duration on any leg left talk_seconds null, and zone-less times
--   ("2026-10-15 19:49:05", India time) were read as UTC.
-- Fix (Worker): one toIso that reads IST wall-clock times, and settleTiming: MyOperator's times first, the Worker's
--   clock last, started <= answered <= ended, and a talk time on every connected call (0 + duration_flag 'unknown'
--   when nothing says how long).
-- This migration:
--   * calls.duration_flag: null (as reported) / derived / clamped / repaired / unknown;
--   * a trigger that corrects inverted timestamps on every write, whoever writes them;
--   * a one-off repair of existing connected calls: recomputed from the stored MyOperator payload where possible,
--     else talk set to null and flagged 'unknown'. Every changed row goes to audit_log; counts in the notice;
--   * averages (dashboard, MIS, agents) skip calls whose duration is unknown or inverted instead of counting 0;
--   * callback_call_ended treats an unknown talk time like "not reported" (reached), as it did for null.
-- Expand only: new column, new functions, replaced view / function.
-- =====================================================================
alter table calls add column if not exists duration_flag text;
alter table calls drop constraint if exists calls_duration_flag_check;
alter table calls add constraint calls_duration_flag_check
  check (duration_flag is null or duration_flag in ('derived','clamped','repaired','unknown'));

-- A MyOperator time as stored in calls.raw: epoch s / ms, ISO with a zone, or India wall-clock time without one.
create or replace function mo_ts(p text) returns timestamptz language plpgsql stable as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  p := btrim(p);
  if p ~ '^\d+(\.\d+)?$' then
    return to_timestamp(case when p::numeric >= 1e12 then p::numeric / 1000 else p::numeric end);
  end if;
  if p ~ '^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$' then
    return (replace(p, 'T', ' ')::timestamp at time zone 'Asia/Kolkata');
  end if;
  return p::timestamptz;
exception when others then return null;
end $$;

-- Seconds from 95, "95", "00:01:35" or "1:35".
create or replace function mo_secs(p text) returns int language plpgsql stable as $$
declare parts text[]; s numeric := 0; x text;
begin
  if p is null or btrim(p) = '' then return null; end if;
  if btrim(p) ~ '^\d+(\.\d+)?$' then return round(btrim(p)::numeric)::int; end if;
  if btrim(p) !~ '^\d+:[0-5]?\d(:[0-5]?\d)?$' then return null; end if;
  parts := string_to_array(btrim(p), ':');
  foreach x in array parts loop s := s * 60 + x::numeric; end loop;
  return s::int;
exception when others then return null;
end $$;

-- ---------- one-off repair of existing connected calls ----------
do $$
declare r record; v_end timestamptz; v_start timestamptz; v_talk int; v_ans timestamptz;
        n_inverted int := 0; n_inverted_fixed int := 0; n_null int := 0; n_null_fixed int := 0; n_unknown int := 0; n_early int := 0;
begin
  for r in select c.*, (c.answered_at is not null and c.ended_at is not null and c.ended_at < c.answered_at) as inverted
             from calls c
            where c.status in ('completed','answered')
              and ((c.answered_at is not null and c.ended_at is not null and c.ended_at < c.answered_at)
                   or (c.status = 'completed' and c.talk_seconds is null and c.duration_flag is null))
            order by c.started_at
            for update of c loop
    -- recompute from MyOperator's own end payload (after-call: _st/_et/_dr; v2 call.end: payload times + leg talk)
    v_end := coalesce(mo_ts(r.raw->'end'->>'_et'), mo_ts(r.raw->'end'->'payload'->>'ended_at'), mo_ts(r.raw->'end'->>'timestamp'));
    v_start := coalesce(mo_ts(r.raw->'end'->>'_st'), mo_ts(r.raw->'end'->'payload'->>'started_at'), r.started_at);
    v_talk := coalesce(mo_secs(r.raw->'end'->>'_dr'), mo_secs(r.raw->'end'->>'_drs'),
      (select sum(mo_secs(l->>'talk_duration'))::int from jsonb_array_elements(case when jsonb_typeof(r.raw->'end'->'payload'->'legs') = 'array'
         then r.raw->'end'->'payload'->'legs' else '[]'::jsonb end) l where l->>'talk_duration' is not null),
      mo_secs(r.raw->'end'->'payload'->>'talk_duration'));
    if v_start is not null and v_end is not null and v_end < v_start then v_start := v_end; end if;
    if v_talk is not null and v_start is not null and v_end is not null and v_talk > extract(epoch from (v_end - v_start)) + 1 then v_talk := null; end if;
    if r.inverted then n_inverted := n_inverted + 1; else n_null := n_null + 1; end if;

    if v_end is not null and v_talk is not null then
      v_ans := greatest(v_end - make_interval(secs => v_talk), coalesce(v_start, v_end - make_interval(secs => v_talk)));
      update calls set ended_at = v_end, answered_at = v_ans, talk_seconds = v_talk, duration_flag = 'repaired' where id = r.id;
      if r.inverted then n_inverted_fixed := n_inverted_fixed + 1; else n_null_fixed := n_null_fixed + 1; end if;
    elsif not r.inverted and r.answered_at is not null and r.ended_at is not null
          and extract(epoch from (r.ended_at - r.answered_at)) between 0 and 14400 then
      update calls set talk_seconds = round(extract(epoch from (r.ended_at - r.answered_at)))::int, duration_flag = 'derived' where id = r.id;
      n_null_fixed := n_null_fixed + 1;
    else
      -- nothing trustworthy: keep the call, no duration, flagged; answered_at no later than ended_at
      update calls set talk_seconds = null, duration_flag = 'unknown',
        answered_at = case when answered_at is not null and ended_at is not null and answered_at > ended_at then ended_at else answered_at end
       where id = r.id;
      n_unknown := n_unknown + 1;
    end if;
    insert into audit_log(workspace_id, table_name, record_id, action, changes, actor_id)
    select c.workspace_id, 'calls', c.id, 'update',
      jsonb_build_object('answered_at', jsonb_build_object('old', r.answered_at, 'new', c.answered_at),
        'ended_at', jsonb_build_object('old', r.ended_at, 'new', c.ended_at),
        'talk_seconds', jsonb_build_object('old', r.talk_seconds, 'new', c.talk_seconds),
        'duration_flag', c.duration_flag, 'reason', case when r.inverted then 'ended before answered' else 'talk time missing' end,
        'migration', '20261019180200_call_timing_integrity'), null
      from calls c where c.id = r.id;
  end loop;
  -- answered before the call started (server clock vs provider clock): clamp
  update calls set answered_at = started_at, duration_flag = coalesce(duration_flag, 'clamped')
   where answered_at is not null and answered_at < started_at;
  get diagnostics n_early = row_count;
  raise notice 'Call timing repair: % inverted (% recomputed from MyOperator), % connected without talk time (% recomputed or derived), % left unknown and flagged, % answered-before-start clamped',
    n_inverted, n_inverted_fixed, n_null, n_null_fixed, n_unknown, n_early;
end $$;

-- ---------- every later write: started <= answered <= ended ----------
create or replace function trg_call_timing_order() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.ended_at is not null and new.started_at is not null and new.ended_at < new.started_at then
    new.started_at := new.ended_at;
  end if;
  if new.answered_at is not null and new.started_at is not null and new.answered_at < new.started_at then
    new.answered_at := new.started_at;
    if new.status in ('answered','completed') then new.duration_flag := coalesce(new.duration_flag, 'clamped'); end if;
  end if;
  if new.answered_at is not null and new.ended_at is not null and new.answered_at > new.ended_at then
    new.answered_at := new.ended_at;
    if new.status in ('answered','completed') then new.duration_flag := coalesce(new.duration_flag, 'clamped'); end if;
  end if;
  if new.talk_seconds is not null and new.talk_seconds < 0 then
    new.talk_seconds := null; new.duration_flag := 'unknown';
  end if;
  return new;
end $$;
drop trigger if exists call_timing_order on calls;
create trigger call_timing_order before insert or update of started_at, answered_at, ended_at, talk_seconds on calls
  for each row execute function trg_call_timing_order();

-- ---------- averages skip unknown or inverted durations (one row per call, same columns as before) ----------
create or replace view public.v_call_metrics with (security_invoker = true) as
select id, workspace_id, agent_id, direction, status, started_at, ring_seconds,
  case when status in ('answered','completed') and talk_seconds between 1 and 14400
         and duration_flag is distinct from 'unknown'
         and not (answered_at is not null and ended_at is not null and ended_at < answered_at)
    then talk_seconds end as talk_seconds
from public.calls;
revoke all on public.v_call_metrics from public;
grant select on public.v_call_metrics to caredesk_app;

-- ---------- callbacks: an unknown talk time is "not reported", as null was ----------
create or replace function callback_call_ended(p_call uuid) returns text
language plpgsql security definer set search_path = public as $$
declare c calls; cb callbacks; v_min_talk constant int := 20;
begin
  select * into c from calls where id = p_call;
  if c.id is null or c.direction <> 'outbound' or c.callback_id is null then return 'none'; end if;
  select * into cb from callbacks where id = c.callback_id for update;
  if cb.workspace_id is distinct from c.workspace_id then return 'missing'; end if;
  if c.id is distinct from (select id from calls where callback_id = cb.id order by started_at desc, id desc limit 1) then return cb.status; end if;
  if cb.id is null then return 'missing'; end if;
  if cb.status = 'reached' and cb.reached_call_id is distinct from c.id then return cb.status; end if;  -- reached by another call
  if cb.status not in ('in_progress','reached') then return cb.status; end if;

  if c.status = 'completed' and (c.talk_seconds is null or c.duration_flag = 'unknown' or c.talk_seconds >= v_min_talk) then
    if cb.status = 'in_progress' then        -- the answered event never came
      update callbacks set status = 'reached', reached_at = coalesce(c.answered_at, c.ended_at, now()), reached_call_id = c.id,
        assigned_to = coalesce(c.agent_id, assigned_to), next_attempt_at = null
      where id = cb.id;
    end if;
    return 'reached';
  end if;

  if cb.status = 'reached' then
    update sla_timers set met_at = null, status = case when status = 'met' then 'running' else status end
    where policy_key = 'missed_callback' and callback_id = cb.id and met_at is not null;
    update callbacks set status = 'in_progress', reached_at = null, reached_call_id = null where id = cb.id;
  end if;
  return callback_retry(cb.id, case when c.status = 'completed'
    then format('patient on the line %s s only', coalesce(c.talk_seconds, 0))
    else coalesce(c.raw->>'callback_failure_reason', 'Call ' || c.status || '; customer connection not verified') end);
end $$;
