-- 0040_fix_db08_refresh_token_caller_context.sql
-- Corrige DB-08 (docs/auditoria-1/db-api-reverificacion.md, CRÍTICA):
-- `app.create_refresh_token(p_id, p_user_id, p_token_hash, p_expires_at)` y
-- `app.revoke_all_refresh_tokens(p_user_id)` (0017_ronda2_extensions.sql)
-- son SECURITY DEFINER y aceptaban `p_user_id` como parámetro arbitrario
-- SIN validar que coincidiera con el llamador -- exactamente el mismo
-- defecto que DB-01 (0010, corregido en 0019), pero introducido en 0017 y
-- nunca revisado. Cualquier sesión con acceso a `app_role` podía acuñar un
-- refresh token válido para CUALQUIER `user_id` (toma de sesión completa) o
-- revocar todas las sesiones de cualquier usuario conociendo solo su id.
--
-- Corrección (mismo patrón que 0019 aplicó a `app.membership_role`/
-- `app.find_user_by_email`): exigir que `app.current_user_id()` ya esté
-- fijado por el llamador y coincida con el `p_user_id` recibido -- nunca se
-- confía en el parámetro por sí solo. La aplicación (apps/api) debe fijar
-- `app.current_user_id()` al id REAL ya verificado (login: recién
-- autenticado por contraseña; refresh: resuelto del propio token JWT
-- firmado por el servidor) ANTES de invocar estas funciones -- nunca a
-- partir de un valor de entrada del cliente sin verificar. Ver
-- apps/api/src/modules/auth/routes.ts (`issueTokenPair`).
--
-- `app.revoke_all_refresh_tokens` no tiene ningún caso de uso real en
-- apps/api hoy (confirmado por grep), pero en vez de eliminarla se
-- restringe a autorrevocación (`p_user_id = app.current_user_id()`) o
-- superadmin (`app.is_superadmin()`), conservando la superficie mínima por
-- si se implementa "cerrar sesión en todos los dispositivos" o un panel de
-- back office, sin reabrir DB-08.
--
-- Se mantienen las firmas originales (mismos parámetros) para no romper
-- otros llamadores existentes; el control se añade DENTRO de la función.

create or replace function app.create_refresh_token(
  p_id uuid, p_user_id uuid, p_token_hash text, p_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_user_id() is null or app.current_user_id() <> p_user_id then
    raise exception 'create_refresh_token_requires_matching_user_context';
  end if;

  insert into refresh_tokens (id, user_id, token_hash, expires_at)
  values (p_id, p_user_id, p_token_hash, p_expires_at);
end;
$$;

create or replace function app.revoke_all_refresh_tokens(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (app.current_user_id() = p_user_id or app.is_superadmin()) then
    raise exception 'revoke_all_refresh_tokens_requires_matching_user_or_superadmin';
  end if;

  update refresh_tokens set revoked_at = now()
  where user_id = p_user_id and revoked_at is null;
end;
$$;

-- Defensa en profundidad: aunque `ALTER DEFAULT PRIVILEGES` (0001) ya
-- concede EXECUTE a `app_role` sobre las funciones de `app`, Postgres
-- también concede EXECUTE a PUBLIC por defecto al crear una función salvo
-- que se revoque explícitamente. Se revoca PUBLIC de las 4 funciones de
-- `refresh_tokens` (incluidas las que no cambian de lógica en esta
-- migración) para que solo `app_role` pueda invocarlas.
revoke execute on function app.create_refresh_token(uuid, uuid, text, timestamptz) from public;
revoke execute on function app.find_refresh_token(text) from public;
revoke execute on function app.revoke_refresh_token(text) from public;
revoke execute on function app.revoke_all_refresh_tokens(uuid) from public;

grant execute on function app.create_refresh_token(uuid, uuid, text, timestamptz) to app_role;
grant execute on function app.find_refresh_token(text) to app_role;
grant execute on function app.revoke_refresh_token(text) to app_role;
grant execute on function app.revoke_all_refresh_tokens(uuid) to app_role;
