-- Product details for service-provider logins (21 Oct 2026). Book My Medicare works inside CareDesk with its own
-- logins (role provider, profiles.provider_id) and needs the product details of what it delivers. A provider login
-- now reads service_knowledge for the categories its provider delivers (providers.categories): service rows whose
-- service is in one of them and the category defaults of those categories. Staff read everything, as before.
-- Editing stays with supervisor / admin (save_service_knowledge, import_service_knowledge). Prices shown with it are
-- the rate card (services, already readable by providers); buying rates and margins stay confidential.
create or replace function public.me_provider_categories() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce((select p.categories from providers p where p.id = me_provider() and p.active), '{}'::text[])
$$;
revoke all on function public.me_provider_categories() from public;
grant execute on function public.me_provider_categories() to caredesk_app;

drop policy if exists service_knowledge_read on service_knowledge;
create policy service_knowledge_read on service_knowledge for select using (
  workspace_id = me_ws() and (
    not has_role('provider')
    or category = any(me_provider_categories())
    or exists (select 1 from services s where s.id = service_knowledge.service_id and s.category = any(me_provider_categories()))
  )
);
