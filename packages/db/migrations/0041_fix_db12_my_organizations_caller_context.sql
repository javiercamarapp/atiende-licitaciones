-- 0041_fix_db12_my_organizations_caller_context.sql
-- DB-12 (nuevo, encontrado durante la auditoría exhaustiva de funciones
-- SECURITY DEFINER pedida junto con DB-08 -- ver
-- docs/auditoria-1/db-api-reverificacion.md, sección DB-08): el mismo
-- patrón de DB-01/DB-08 (parámetro de identidad externo sin validar contra
-- el llamador) seguía vivo, sin revisar, en
-- `app.my_organizations(p_user_id uuid)` (0010_app_support_functions.sql),
-- que nunca fue tocada por 0019 (esa migración solo corrigió
-- `membership_role`/`find_user_by_email`).
--
-- Reataque confirmado: cualquier sesión autenticada podía invocar
-- `select * from app.my_organizations($victim_user_id)` y obtener la lista
-- completa de organizaciones/roles de CUALQUIER otro usuario -- exactamente
-- el mismo tipo de fuga de DB-01, por una función distinta.
-- `apps/api/src/modules/organizations/routes.ts` (`GET /organizations`)
-- SIEMPRE la invocaba con `request.userId` (el propio actor autenticado,
-- nunca un id de otro usuario) y sin fijar `app.current_user_id()` primero
-- -- coincide exactamente con el único uso legítimo, igual que
-- `app.membership_role` antes de 0019.
--
-- Corrección (mismo patrón que 0019): función de 0 argumentos que SIEMPRE
-- resuelve las organizaciones del propio `app.current_user_id()`. Se
-- elimina la versión de 1 argumento.

drop function if exists app.my_organizations(uuid);

create or replace function app.my_organizations()
returns table (org_id uuid, org_name text, org_slug text, role org_role)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id, o.name, o.slug, m.role
  from memberships m
  join organizations o on o.id = m.org_id
  where m.user_id = app.current_user_id()
    and m.status = 'active'
  order by o.name
$$;

revoke execute on function app.my_organizations() from public;
grant execute on function app.my_organizations() to app_role;
