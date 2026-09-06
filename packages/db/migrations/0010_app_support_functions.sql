-- 0010_app_support_functions.sql
-- Funciones de soporte para la API (apps/api), necesarias por el mismo
-- motivo que app.org_has_no_memberships en 0007: hay operaciones (login,
-- resolución de organización desde el header X-Org-Id) que deben ejecutarse
-- ANTES de que exista un contexto de sesión (app.current_user_id todavía no
-- se puede fijar porque es precisamente lo que la operación tiene que
-- averiguar). Se resuelven con funciones SECURITY DEFINER de alcance minimo
-- (devuelven solo los campos estrictamente necesarios), nunca desactivando
-- RLS de forma general ni usando el rol propietario desde la API.

-- Login: busca credenciales por email sin requerir contexto de usuario
-- previo (por definición, en login todavía no se conoce el id del actor).
create or replace function app.find_user_by_email(p_email text)
returns table (id uuid, password_hash text, is_active boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select u.id, u.password_hash, u.is_active
  from users u
  where lower(u.email) = lower(p_email)
  limit 1
$$;

-- Resolución de organización activa: valida el header X-Org-Id contra la
-- membresía real del usuario autenticado ANTES de fijar app.current_org_id
-- (que es justamente lo que esta consulta decide si procede fijar).
create or replace function app.membership_role(p_org_id uuid, p_user_id uuid)
returns org_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.role
  from memberships m
  where m.org_id = p_org_id
    and m.user_id = p_user_id
    and m.status = 'active'
  limit 1
$$;

-- Lista de organizaciones de un usuario (para "GET /organizations", listar
-- las mías) junto con el rol, sin depender de tener ya un org_id fijado.
create or replace function app.my_organizations(p_user_id uuid)
returns table (org_id uuid, org_name text, org_slug text, role org_role)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id, o.name, o.slug, m.role
  from memberships m
  join organizations o on o.id = m.org_id
  where m.user_id = p_user_id
    and m.status = 'active'
  order by o.name
$$;
