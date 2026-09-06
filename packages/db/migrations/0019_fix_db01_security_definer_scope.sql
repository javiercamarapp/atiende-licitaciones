-- 0019_fix_db01_security_definer_scope.sql
-- Corrige DB-01 (docs/auditoria-1/db-api.md, ALTA): dos funciones
-- SECURITY DEFINER de 0010_app_support_functions.sql eran invocables
-- directamente por cualquier sesión ya autenticada, con parámetros
-- arbitrarios, sin ninguna verificación de quién llama:
--
--   - `app.membership_role(p_org_id uuid, p_user_id uuid)` devolvía el rol
--     REAL de cualquier `p_user_id` en cualquier `p_org_id`, sin exigir que
--     el llamador tuviera relación alguna con ese usuario/organización.
--     Verificado con ataque directo: un actor de la organización B obtenía
--     el rol de un usuario de la organización A.
--   - `app.find_user_by_email(p_email text)` devolvía `password_hash` de
--     CUALQUIER usuario por email, sin ninguna restricción de cuándo puede
--     invocarse (estaba pensada solo para el login, es decir, ANTES de que
--     exista contexto de sesión).
--
-- Corrección:
--   1. Se elimina la función de 2 argumentos `app.membership_role` y se
--      sustituye por una de 1 argumento que SIEMPRE resuelve la membresía
--      del propio `app.current_user_id()` -- coincide exactamente con el
--      único uso legítimo real (apps/api/src/plugins/auth.plugin.ts,
--      `requireOrg`, que ya solo pasaba el id del propio actor autenticado;
--      ahora la base de datos lo garantiza, no la aplicación).
--   2. `app.find_user_by_email` ahora rechaza ejecutarse (`raise exception`)
--      si `app.current_user_id()` ya está fijado -- es decir, solo puede
--      usarse en el contexto "pre-sesión" para el que fue diseñada (login).
--      Cualquier código futuro que la llame después de autenticar (con
--      `set_config('app.current_user_id', ...)` ya hecho, como exige el
--      patrón de esta base de código) queda bloqueado en la propia base de
--      datos, no solo por convención de la aplicación.

drop function if exists app.membership_role(uuid, uuid);

create or replace function app.membership_role(p_org_id uuid)
returns org_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.role
  from memberships m
  where m.org_id = p_org_id
    and m.user_id = app.current_user_id()
    and m.status = 'active'
  limit 1
$$;

create or replace function app.find_user_by_email(p_email text)
returns table (id uuid, password_hash text, is_active boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_user_id() is not null then
    raise exception 'find_user_by_email_not_allowed_in_session_context';
  end if;

  return query
    select u.id, u.password_hash, u.is_active
    from users u
    where lower(u.email) = lower(p_email)
    limit 1;
end;
$$;
