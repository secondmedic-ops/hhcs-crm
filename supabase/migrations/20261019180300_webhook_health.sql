-- =====================================================================
-- CareDesk CRM  |  MyOperator webhook health
--   No call has been recorded since 15 Oct and nothing in the app said so. This adds:
--   * the alert window setting: workspaces.settings.webhook_alert_hours (default 4, 1 to 24), set by a supervisor
--     with set_webhook_alert_hours();
--   * webhook_silence_check() for the minute cron: during working hours (09:00 to 21:00 IST), when no MyOperator
--     webhook event has arrived for N hours (counted from 09:00 IST at the earliest), one notification to supervisors
--     per silence. The call-log sync does not count: it is the fallback, the webhook is what is checked;
--   * rejected webhook posts (401 wrong key / 503 key not set) are noted by the Worker in integration_settings
--     ('webhook_health', system-only) and shown, without the key or the body, in Settings > Telephony > Webhook health.
-- Expand only.
-- =====================================================================
create index if not exists webhook_events_received on webhook_events(source, received_at desc);

create or replace function webhook_alert_hours(p_ws uuid) returns int
language sql stable security definer set search_path = public as $$
  select least(24, greatest(1, coalesce((settings->>'webhook_alert_hours')::int, 4))) from workspaces where id = p_ws
$$;

create or replace function set_webhook_alert_hours(p_hours int) returns int
language plpgsql security definer set search_path = public as $$
declare v_ws uuid := me_ws();
begin
  if not has_role('supervisor') then raise exception 'Only a supervisor can change the webhook alert'; end if;
  if p_hours is null or p_hours < 1 or p_hours > 24 then raise exception 'Alert after 1 to 24 hours without events'; end if;
  update workspaces set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('webhook_alert_hours', p_hours) where id = v_ws;
  insert into access_log(workspace_id, user_id, action, entity, entity_id, meta)
  values (v_ws, app_uid(), 'settings_changed', 'webhook_alert', v_ws::text, jsonb_build_object('hours', p_hours));
  return p_hours;
end $$;
grant execute on function set_webhook_alert_hours(int) to caredesk_app;

-- p_now only for tests; the cron passes nothing.
create or replace function webhook_silence_check(p_now timestamptz default now()) returns int
language plpgsql security definer set search_path = public as $$
declare w record; v_local timestamp := p_now at time zone 'Asia/Kolkata'; v_open timestamptz; v_last timestamptz;
        v_since timestamptz; v_hours int; n int := 0;
begin
  if not is_service() then raise exception 'System only'; end if;
  if extract(hour from v_local) < 9 or extract(hour from v_local) >= 21 then return 0; end if;
  v_open := (date_trunc('day', v_local) + interval '9 hours') at time zone 'Asia/Kolkata';
  select max(received_at) into v_last from webhook_events where source = 'myoperator' and received_at <= p_now;
  v_since := greatest(coalesce(v_last, v_open), v_open);
  for w in select id from workspaces loop
    v_hours := webhook_alert_hours(w.id);
    continue when p_now - v_since < make_interval(hours => v_hours);
    -- once per silence: nothing new since the last alert
    continue when exists (select 1 from notifications where workspace_id = w.id and kind = 'webhook_silence' and created_at >= v_since);
    insert into notifications(workspace_id, role, kind, title, body, link, created_at)
    values (w.id, 'supervisor', 'webhook_silence', format('No MyOperator call events for %s h', v_hours),
      case when v_last is null then 'CareDesk has never received a MyOperator webhook. Check the webhook address and key in MyOperator.'
           else format('Last webhook event %s IST. Calls may not be reaching CareDesk: check Settings > Telephony > Webhook health.',
                       to_char(v_last at time zone 'Asia/Kolkata', 'DD Mon HH24:MI')) end,
      '/settings?tab=telephony', p_now);
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function webhook_silence_check(timestamptz) from public;
