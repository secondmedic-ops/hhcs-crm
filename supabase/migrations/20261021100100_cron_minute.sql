-- The minute cron in ONE statement (21 Oct 2026). services/cron.ts ran the missed-call sweep, the webhook-silence
-- check, the SLA scan, due-price activation and the auto-dialer claim as five transactions (about 25 queries a minute,
-- 36,000 a day, against the Hyperdrive free plan's 100,000). cron_minute() runs the same steps in the same order in
-- one call. Each step is its own block: an error in one is rolled back alone and reported in `errors`; the
-- others still run, as before. Called only from the Worker's cron through asSystem (service_role).
-- p_autodial = false when MyOperator calling is not configured: callbacks then stay in the queue (no claim).
create or replace function public.cron_minute(p_autodial boolean default true) returns jsonb
language plpgsql as $$
declare v_out jsonb := '{}'::jsonb; v_err jsonb := '{}'::jsonb;
begin
  if not is_service() then raise exception 'System only'; end if;
  begin v_out := v_out || jsonb_build_object('swept', sweep_missed_callbacks());
  exception when others then v_err := v_err || jsonb_build_object('sweep', sqlerrm); end;
  begin v_out := v_out || jsonb_build_object('silence', webhook_silence_check());
  exception when others then v_err := v_err || jsonb_build_object('silence', sqlerrm); end;
  begin v_out := v_out || jsonb_build_object('sla', sla_scan());
  exception when others then v_err := v_err || jsonb_build_object('sla', sqlerrm); end;
  begin v_out := v_out || jsonb_build_object('prices', activate_due_prices());
  exception when others then v_err := v_err || jsonb_build_object('prices', sqlerrm); end;
  if p_autodial then
    begin v_out := v_out || jsonb_build_object('claims', coalesce(autodial_claim(), '[]'::jsonb));
    exception when others then v_err := v_err || jsonb_build_object('autodial', sqlerrm); end;
  end if;
  return v_out || jsonb_build_object('claims', coalesce(v_out -> 'claims', '[]'::jsonb), 'errors', v_err);
end $$;
revoke all on function public.cron_minute(boolean) from public;
