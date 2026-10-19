-- =====================================================================
-- CareDesk CRM  |  Every missed / abandoned inbound call gets a callback (or a visible reason)
-- Root cause (15 Oct 19:49 IST missed call, no callback):
--   * the app skipped the callback silently when ANY pending callback existed for the same number. Callbacks
--     queued before the auto-dialer (9 / 12 Oct) have no next_attempt_at, so the dialer and the expiry sweep never
--     touch them: they stay pending forever and swallowed every later missed call from that number;
--   * a missed call with no caller number (withheld / IVR) was skipped with no trace;
--   * only the two webhook end paths queued callbacks: a call that became missed any other way got nothing.
-- Fix:
--   * queue_missed_callback(call): one function, exactly once per call. It merges into an existing callback only
--     when that callback is live (being dialled, or still in its retry window / the manual queue); a stale one
--     no longer swallows the call. A merged call is recorded on the callback (merged_call_ids) and the call
--     (callback_note). No number: calls.callback_note says so.
--   * the Worker calls it on both end paths, and the minute cron sweeps the last 24 h for any missed / abandoned
--     inbound call left without a callback or a note (catches later events, imports and repairs).
--   * one-off backfill since 13 Oct: missed calls with a number and no callback are queued as pending,
--     marked backfilled, never auto-dialled when older than 24 h, and with no SLA timer (the SLA is long gone).
-- Expand only: new nullable / defaulted columns, new functions.
-- =====================================================================
alter table calls add column if not exists callback_note text;
alter table callbacks add column if not exists backfilled boolean not null default false;
alter table callbacks add column if not exists merged_call_ids uuid[] not null default '{}';

create or replace function queue_missed_callback(p_call uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare c calls; v_cb uuid; v_min int; cfg jsonb;
begin
  select * into c from calls where id = p_call;
  if c.id is null or c.direction <> 'inbound' or c.status not in ('missed','abandoned') then return null; end if;
  -- exactly once per call: its own callback, or the live callback it was merged into
  select id into v_cb from callbacks where call_id = c.id and reason in ('missed','abandoned') limit 1;
  if v_cb is not null then return v_cb; end if;
  select id into v_cb from callbacks where c.id = any(merged_call_ids) limit 1;
  if v_cb is not null then return v_cb; end if;

  if nullif(btrim(coalesce(c.customer_number, '')), '') is null then
    update calls set callback_note = 'No caller number: cannot call back'
      where id = c.id and callback_note is distinct from 'No caller number: cannot call back';
    return null;
  end if;

  -- same lock key the Worker used, so two end events for one number never queue twice
  perform pg_advisory_xact_lock(hashtextextended(c.workspace_id::text || ':' || c.customer_number, 0));
  select id into v_cb from callbacks where call_id = c.id and reason in ('missed','abandoned') limit 1;
  if v_cb is not null then return v_cb; end if;

  cfg := autodial_cfg(c.workspace_id);
  -- live = being dialled, or still waiting inside its window (auto-dialer) / in the manual queue (auto-dialer off)
  select b.id into v_cb from callbacks b
   where b.workspace_id = c.workspace_id and b.number = c.customer_number
     and (b.status = 'in_progress'
          or (b.status = 'pending' and b.due_at > now()
              and (b.next_attempt_at is not null or not coalesce((cfg->>'enabled')::boolean, false))))
   order by b.created_at limit 1 for update;
  if v_cb is not null then
    update callbacks set merged_call_ids = array_append(merged_call_ids, c.id) where id = v_cb;
    update calls set callback_note = 'Same number already in the callback queue' where id = c.id;
    return v_cb;
  end if;

  select target_minutes into v_min from sla_policies where workspace_id = c.workspace_id and key = 'missed_callback';
  insert into callbacks (workspace_id, call_id, number, patient_id, reason, due_at)
  values (c.workspace_id, c.id, c.customer_number, c.patient_id,
          case when c.status = 'abandoned' then 'abandoned' else 'missed' end,
          now() + make_interval(mins => coalesce(v_min, 10)))
  returning id into v_cb;
  update calls set callback_note = null where id = c.id and callback_note is not null;
  return v_cb;
end $$;
revoke all on function queue_missed_callback(uuid) from public;

-- Safety net for the minute cron: any missed / abandoned inbound call of the last 24 h with neither a callback
-- nor a note, whatever made it missed (later webhook event, call-log sync, import, repair).
create or replace function sweep_missed_callbacks() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  if not is_service() then raise exception 'System only'; end if;
  for r in select k.id from calls k
            where k.direction = 'inbound' and k.status in ('missed','abandoned')
              and coalesce(k.ended_at, k.started_at) > now() - interval '24 hours'
              and k.callback_note is null
              and not exists (select 1 from callbacks b where b.call_id = k.id)
              and not exists (select 1 from callbacks b where k.id = any(b.merged_call_ids))
            order by k.started_at loop
    if queue_missed_callback(r.id) is not null then n := n + 1; end if;
  end loop;
  return n;
end $$;
revoke all on function sweep_missed_callbacks() from public;

-- One-off backfill (13 Oct 2026 onwards, when the auto-dialer went live). Idempotent: a call that has a callback
-- or is merged into one is skipped on a rerun.
do $$
declare r record; v_cb uuid; n_new int := 0; n_manual int := 0; n_no_number int := 0;
begin
  for r in select k.* from calls k
            where k.direction = 'inbound' and k.status in ('missed','abandoned')
              and k.started_at >= timestamptz '2026-10-13 00:00:00+05:30'
              and not exists (select 1 from callbacks b where b.call_id = k.id)
              and not exists (select 1 from callbacks b where k.id = any(b.merged_call_ids))
            order by k.started_at loop
    if nullif(btrim(coalesce(r.customer_number, '')), '') is null then
      update calls set callback_note = 'No caller number: cannot call back' where id = r.id;
      n_no_number := n_no_number + 1;
      continue;
    end if;
    insert into callbacks (workspace_id, call_id, number, patient_id, reason, due_at, backfilled, notes)
    values (r.workspace_id, r.id, r.customer_number, r.patient_id,
            case when r.status = 'abandoned' then 'abandoned' else 'missed' end,
            now() + interval '24 hours', true,
            'Backfilled 19 Oct 2026: this missed call never got a callback. Decide whether to call back.')
    returning id into v_cb;
    n_new := n_new + 1;
    -- older than 24 h: a human decides, the auto-dialer never picks it up; no SLA timer (it was missed long ago)
    if coalesce(r.ended_at, r.started_at) < now() - interval '24 hours' then
      update callbacks set next_attempt_at = null, auto_dialled = false, due_at = now() + interval '24 hours'
       where id = v_cb;
      delete from sla_timers where callback_id = v_cb and policy_key = 'missed_callback';
      n_manual := n_manual + 1;
    end if;
  end loop;
  if n_new + n_no_number > 0 then
    insert into audit_log (table_name, action, changes)
    values ('callbacks', 'backfill_missed_callbacks', jsonb_build_object('queued', n_new, 'manual_only', n_manual,
      'no_caller_number', n_no_number, 'migration', '20261019180000_missed_call_callback_guarantee'));
  end if;
  raise notice 'Missed-call backfill: % callbacks queued (% manual only, older than 24 h), % calls without a number noted',
    n_new, n_manual, n_no_number;
end $$;
