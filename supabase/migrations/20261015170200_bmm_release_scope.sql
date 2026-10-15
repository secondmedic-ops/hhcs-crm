-- BMM partner API: share only the lines that are BMM's, in the unit agreed on the booking.
--   * A line whose provider was chosen on the case (case_item_costs.provider_id, set by pricing or set_item_provider)
--     goes only to that provider; category routing applies only to lines with no provider chosen. So a nursing line
--     moved to SecondMedic is never sent to BMM, and an "other" line explicitly given to BMM is.
--   * The unit is the snapshot on the case line (case_items.unit), falling back to the rate card for older lines.
-- The buying cost itself is never returned. Everything else is unchanged from 20261014100000_bmm_partner_api.sql.
create or replace function bmm_leads(p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_provider uuid := bmm_provider(); v jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 then raise exception 'Invalid pagination'; end if;
  with permitted as (
    select r.*, c.case_no, c.patient_id, c.address, c.pincode, c.branch, c.services_requested,
      c.expected_discharge_on, c.plan_days, c.hospital_name, c.stage = 'cancelled' as case_cancelled,
      (r.status = 'cancelled' or c.stage = 'cancelled' or (c.care_type = 'post_discharge' and c.signoff_at is null)) as withdrawn
    from case_referrals r join cases c on c.id = r.case_id
    where r.workspace_id = me_ws() and c.workspace_id = me_ws() and r.provider_id = v_provider
  ), page as (select * from permitted order by created_at, id limit p_limit offset p_offset)
  select jsonb_build_object('total', (select count(*) from permitted), 'limit', p_limit, 'offset', p_offset,
    'leads', coalesce((select jsonb_agg(
      case when r.withdrawn then jsonb_build_object('referral_id',r.id,'case_id',r.case_id,'case_no',r.case_no,
        'status',case when r.status = 'cancelled' or r.case_cancelled then 'cancelled' else 'on_hold' end,'updated_at',r.updated_at)
      else jsonb_build_object('referral_id',r.id,'case_id',r.case_id,'case_no',r.case_no,'status',r.status,
        'updated_at',r.updated_at,'scheduled_at',r.scheduled_at,'dispatched_at',r.dispatched_at,'started_at',r.started_at,
        'completed_at',r.completed_at,'last_note',r.last_note,'decline_reason',r.decline_reason,
        'patient',jsonb_build_object('name',p.full_name,'mobile',p.mobile,'address',coalesce(r.address,p.address),
          'pincode',coalesce(r.pincode,p.pincode)), 'branch',r.branch,'hospital',r.hospital_name,
        'expected_discharge_on',r.expected_discharge_on,'plan_days',r.plan_days,
        'items',coalesce((select jsonb_agg(jsonb_build_object('case_item_id',i.id,'service_code',i.service_code,
          'service_name',i.service_name,'category',i.category,'quantity',i.qty,'unit',coalesce(i.unit,s.unit)) order by i.created_at,i.id)
          from case_items i join services s on s.id = i.service_id join providers pv on pv.id = v_provider
          left join case_item_costs k on k.case_item_id = i.id
          where i.case_id = r.case_id and not i.excluded
            and (k.provider_id = v_provider or (k.provider_id is null and i.category = any(pv.categories)))), '[]'::jsonb)) end
      order by r.created_at,r.id) from page r join patients p on p.id = r.patient_id and p.workspace_id = me_ws()), '[]'::jsonb)) into v;
  insert into access_log(workspace_id,user_id,action,entity,meta)
    values(me_ws(),app_uid(),'partner_api_read','case_referrals',jsonb_build_object('offset',p_offset,'limit',p_limit));
  return v;
end $$;
revoke all on function bmm_leads(int,int) from public;
grant execute on function bmm_leads(int,int) to caredesk_app;
