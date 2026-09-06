-- 0052_org_members_listing.sql
-- Ronda 4 (docs/logs/api-ronda4.log): apps/web (README, sección "Endpoints
-- de apps/api que SÍ existen pero no se pudieron conectar") señaló que
-- apps/api no expone ningún endpoint para LISTAR los miembros de una
-- organización -- `GET /organizations` solo devuelve las organizaciones DEL
-- USUARIO ACTUAL (`app.my_organizations()`), nunca los miembros de una org
-- dada.
--
-- La RLS de `memberships` (0008_rls_policies.sql, `sel_memberships`) YA
-- permite a cualquier miembro activo (cualquier rol, incluido `viewer`) ver
-- las filas de `memberships` de su propia organización. Lo que falta es
-- resolver el email/nombre del USUARIO de cada membresía sin tropezar con
-- la RLS de `users` (0008, `sel_users`: un actor normal solo ve su PROPIA
-- fila, salvo superadmin) -- necesario para que el back office muestre
-- "quién es quién", no solo un `user_id` opaco.
--
-- `app.org_members(p_org_id uuid)` es SECURITY DEFINER (mismo patrón que
-- `app.my_organizations`/`app.membership_role`), pero -- a diferencia de
-- ambas -- SÍ recibe un `p_org_id` como parámetro; para no repetir el error
-- de DB-01 (una función SECURITY DEFINER que confía en un parámetro de
-- identidad sin verificar nada contra el llamador real), verifica DENTRO de
-- la función que quien invoca es miembro activo de esa organización
-- (cualquier rol) o superadmin -- nunca una organización arbitraria sin
-- relación con `app.current_user_id()`.
create or replace function app.org_members(p_org_id uuid)
returns table (
  user_id uuid,
  email text,
  full_name text,
  role org_role,
  status membership_status,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (
    app.is_superadmin()
    or app.has_role(p_org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[])
  ) then
    raise exception 'org_members_forbidden';
  end if;

  return query
    select u.id, u.email, u.full_name, m.role, m.status, m.created_at
    from memberships m
    join users u on u.id = m.user_id
    where m.org_id = p_org_id
    order by m.created_at asc, u.id asc;
end;
$$;
