-- =====================================================================
-- CareDesk CRM  |  0003  Row-level security (slide 20 role matrix)
--   agent            own queue only, masked numbers, no export
--   coordinator      all active cases, scheduling, field assignment
--   supervisor       everything operational + recordings + QA + export (logged)
--   field_staff      only assigned visits
--   medical_desk     clinical triage & escalations
--   client_manager   Hinduja management: full read, approvals, export
--   client_clinical  Hinduja clinical: cases, reports, escalations
--   admin            configuration only, no patient data
-- =====================================================================

do $$ declare t text; begin
  foreach t in array array['workspaces','zones','profiles','services','templates','sla_policies','escalation_matrix',
    'patients','case_counters','cases','case_items','case_stage_history','calls','webhook_events','interactions','callbacks',
    'approvals','sla_timers','complaints','escalations','assignments','samples','payments','qa_reviews','audit_log',
    'access_log','notifications','mis_snapshots','inbound_emails'] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- helper: can the current user see this case?
create or replace function can_see_case(p_case uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from cases c
    where c.id = p_case and c.workspace_id = me_ws() and (
      has_role('coordinator','supervisor','medical_desk','client_manager','client_clinical')
      or (has_role('agent') and (c.owner_id = app_uid() or c.created_by = app_uid() or c.owner_id is null
                                 or (c.stage not in ('closed','cancelled') and c.created_at > now() - interval '2 days')))
      or (has_role('field_staff') and exists (select 1 from assignments a where a.case_id = c.id and a.staff_id = app_uid()
                                              and (a.status in ('assigned','en_route','checked_in')
                                                   or (a.status = 'completed' and a.checkout_at > now() - interval '12 hours'))))
    ))
$$;

-- ---------- configuration ----------
drop policy if exists ws_read on workspaces;
create policy ws_read on workspaces for select using (id = me_ws());
drop policy if exists ws_admin on workspaces;
create policy ws_admin on workspaces for update using (id = me_ws() and has_role('admin','client_manager'));

drop policy if exists zones_read on zones;
create policy zones_read on zones for select using (workspace_id = me_ws());
drop policy if exists zones_write on zones;
create policy zones_write on zones for all using (workspace_id = me_ws() and has_role('admin','supervisor'))
  with check (workspace_id = me_ws() and has_role('admin','supervisor'));

drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select using (workspace_id = me_ws() or id = app_uid());
drop policy if exists profiles_self on profiles;
create policy profiles_self on profiles for update using (id = app_uid()) with check (id = app_uid() and role = me_role());
drop policy if exists profiles_admin on profiles;
create policy profiles_admin on profiles for all using (workspace_id = me_ws() and has_role('admin'))
  with check (workspace_id = me_ws() and has_role('admin'));

drop policy if exists services_read on services;
create policy services_read on services for select using (workspace_id = me_ws());
-- prices change only through request_rate_change -> decide_approval; admins may add inactive drafts
drop policy if exists services_admin_insert on services;
create policy services_admin_insert on services for insert with check (workspace_id = me_ws() and has_role('admin','supervisor') and active = false);
drop policy if exists services_admin_update on services;
create policy services_admin_update on services for update using (workspace_id = me_ws() and has_role('admin','supervisor'));

drop policy if exists templates_read on templates;
create policy templates_read on templates for select using (workspace_id = me_ws());
drop policy if exists templates_write on templates;
create policy templates_write on templates for insert with check (workspace_id = me_ws() and has_role('admin','supervisor') and status = 'draft');
drop policy if exists templates_edit on templates;
create policy templates_edit on templates for update using (workspace_id = me_ws() and has_role('admin','supervisor') and status = 'draft');

drop policy if exists sla_read on sla_policies;
create policy sla_read on sla_policies for select using (workspace_id = me_ws());
drop policy if exists sla_write on sla_policies;
create policy sla_write on sla_policies for all using (workspace_id = me_ws() and has_role('admin','supervisor','client_manager'))
  with check (workspace_id = me_ws() and has_role('admin','supervisor','client_manager'));

drop policy if exists esc_matrix_read on escalation_matrix;
create policy esc_matrix_read on escalation_matrix for select using (workspace_id = me_ws());
drop policy if exists esc_matrix_write on escalation_matrix;
create policy esc_matrix_write on escalation_matrix for all using (workspace_id = me_ws() and has_role('admin','supervisor','client_manager'))
  with check (workspace_id = me_ws() and has_role('admin','supervisor','client_manager'));

-- ---------- patient data (admin excluded by design) ----------
drop policy if exists patients_read on patients;
create policy patients_read on patients for select using (
  workspace_id = me_ws() and (
    has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical')
    or (has_role('field_staff') and exists (select 1 from cases c where c.patient_id = patients.id and can_see_case(c.id)))));
drop policy if exists patients_write on patients;
create policy patients_write on patients for insert with check (workspace_id = me_ws() and is_ops());
drop policy if exists patients_update on patients;
create policy patients_update on patients for update using (workspace_id = me_ws() and is_ops());

drop policy if exists cases_read on cases;
create policy cases_read on cases for select using (can_see_case(id));
drop policy if exists cases_insert on cases;
create policy cases_insert on cases for insert with check (workspace_id = me_ws() and is_ops());
drop policy if exists cases_update on cases;
create policy cases_update on cases for update using (can_see_case(id) and is_ops());

drop policy if exists items_read on case_items;
create policy items_read on case_items for select using (can_see_case(case_id));
drop policy if exists items_write on case_items;
create policy items_write on case_items for all using (can_see_case(case_id) and is_ops()) with check (can_see_case(case_id) and is_ops());

drop policy if exists history_read on case_stage_history;
create policy history_read on case_stage_history for select using (can_see_case(case_id));

drop policy if exists calls_read on calls;
create policy calls_read on calls for select using (
  workspace_id = me_ws() and (
    has_role('coordinator','supervisor','medical_desk','client_manager','client_clinical')
    or (has_role('agent') and (agent_id = app_uid() or agent_id is null))));
drop policy if exists calls_update on calls;
create policy calls_update on calls for update using (workspace_id = me_ws() and is_ops());

drop policy if exists interactions_read on interactions;
create policy interactions_read on interactions for select using (
  workspace_id = me_ws() and (
    (case_id is not null and can_see_case(case_id))
    or (case_id is null and has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical'))));
drop policy if exists interactions_insert on interactions;
create policy interactions_insert on interactions for insert with check (
  workspace_id = me_ws() and (is_ops() or has_role('field_staff')) and channel in ('note','field') and actor_id = app_uid());

drop policy if exists callbacks_read on callbacks;
create policy callbacks_read on callbacks for select using (workspace_id = me_ws() and has_role('agent','coordinator','supervisor','client_manager'));
drop policy if exists callbacks_insert on callbacks;
create policy callbacks_insert on callbacks for insert with check (workspace_id = me_ws() and is_ops());

drop policy if exists approvals_read on approvals;
create policy approvals_read on approvals for select using (
  workspace_id = me_ws() and (has_role('supervisor','coordinator','client_manager','admin') or requested_by = app_uid()));

drop policy if exists sla_timers_read on sla_timers;
create policy sla_timers_read on sla_timers for select using (
  workspace_id = me_ws() and (case_id is null or can_see_case(case_id)) and not has_role('admin','field_staff'));

drop policy if exists complaints_read on complaints;
create policy complaints_read on complaints for select using (
  workspace_id = me_ws() and has_role('agent','coordinator','supervisor','medical_desk','client_manager','client_clinical'));
drop policy if exists complaints_insert on complaints;
create policy complaints_insert on complaints for insert with check (workspace_id = me_ws() and (is_ops() or has_role('client_manager')));
drop policy if exists complaints_update on complaints;
create policy complaints_update on complaints for update using (workspace_id = me_ws() and has_role('supervisor','coordinator','client_manager'));

drop policy if exists esc_read on escalations;
create policy esc_read on escalations for select using (workspace_id = me_ws() and (not has_role('admin','field_staff') or raised_by = app_uid()));
drop policy if exists esc_insert on escalations;
create policy esc_insert on escalations for insert with check (workspace_id = me_ws() and (is_ops() or has_role('field_staff','client_manager','client_clinical')));
drop policy if exists esc_update on escalations;
create policy esc_update on escalations for update using (workspace_id = me_ws() and has_role('supervisor','coordinator','medical_desk','client_manager','client_clinical'));

drop policy if exists asg_read on assignments;
create policy asg_read on assignments for select using (
  workspace_id = me_ws() and (staff_id = app_uid() or has_role('coordinator','supervisor','medical_desk','client_manager','client_clinical','agent')));

drop policy if exists samples_read on samples;
create policy samples_read on samples for select using (can_see_case(case_id));

drop policy if exists payments_read on payments;
create policy payments_read on payments for select using (
  workspace_id = me_ws() and (has_role('coordinator','supervisor','client_manager') or collected_by = app_uid()));

drop policy if exists qa_read on qa_reviews;
create policy qa_read on qa_reviews for select using (
  workspace_id = me_ws() and (has_role('supervisor','client_manager') or agent_id = app_uid()));
drop policy if exists qa_write on qa_reviews;
create policy qa_write on qa_reviews for insert with check (workspace_id = me_ws() and has_role('supervisor'));

drop policy if exists audit_read on audit_log;
create policy audit_read on audit_log for select using (workspace_id = me_ws() and has_role('supervisor','client_manager'));
drop policy if exists access_read on access_log;
create policy access_read on access_log for select using (workspace_id = me_ws() and has_role('supervisor','client_manager'));

drop policy if exists notif_read on notifications;
create policy notif_read on notifications for select using (
  workspace_id = me_ws() and (user_id = app_uid() or (user_id is null and role = me_role())));
drop policy if exists notif_update on notifications;
create policy notif_update on notifications for update using (user_id = app_uid() or (user_id is null and role = me_role()));

drop policy if exists mis_read on mis_snapshots;
create policy mis_read on mis_snapshots for select using (workspace_id = me_ws() and has_role('supervisor','client_manager','client_clinical','coordinator'));

drop policy if exists email_read on inbound_emails;
create policy email_read on inbound_emails for select using (workspace_id = me_ws() and (is_ops() or has_role('client_manager')));

-- webhook_events and case_counters: service role only (no policies => no access for users)

-- ---------- grants ----------
-- The Cloudflare Worker is the only way in. It verifies the Supabase login, checks the route's roles, then runs each
-- request as caredesk_app with the user id set (app_uid()), so every policy above still applies as a second wall.
-- anon / authenticated (Supabase's public Data API and Realtime) get nothing.
do $$ declare r text; begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('revoke execute on all functions in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
      execute format('alter default privileges in schema public revoke execute on functions from %I', r);
    end if;
  end loop;
end $$;
revoke execute on all functions in schema public from public;
alter default privileges in schema public revoke execute on functions from public;

grant usage on schema public to caredesk_app;
grant select, insert, update, delete on all tables in schema public to caredesk_app;
grant usage, select on all sequences in schema public to caredesk_app;
grant execute on all functions in schema public to caredesk_app;
alter default privileges in schema public grant select, insert, update, delete on tables to caredesk_app;
alter default privileges in schema public grant usage, select on sequences to caredesk_app;
alter default privileges in schema public grant execute on functions to caredesk_app;
-- System jobs only (Worker cron, as the database owner)
revoke execute on function generate_mis(text, date, date) from caredesk_app;
revoke execute on function sla_scan() from caredesk_app;
