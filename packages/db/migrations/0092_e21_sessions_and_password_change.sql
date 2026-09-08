-- 0092_e21_sessions_and_password_change.sql
-- E21 (docs/BACKLOG.md), segunda mitad: listar/cerrar sesiones activas
-- (refresh token families) y cambiar contraseña con step-up.
--
-- Modelo real de "sesión" en este esquema (ver 0017/0043): NO existe una
-- columna de "familia"/cadena de rotación -- cada fila de `refresh_tokens`
-- es un token concreto, y `app.rotate_refresh_token` revoca la fila vieja e
-- INSERTA una fila nueva en cada `/auth/refresh` (mismo `user_id`, `id`
-- nuevo). Por construcción, entonces, "las sesiones activas de un usuario"
-- son exactamente sus filas de `refresh_tokens` con `revoked_at is null and
-- expires_at > now()`: como mucho una fila viva por login original (la
-- rotación reemplaza la fila anterior en vez de sumar una nueva sesión
-- viva), así que listar esas filas SÍ refleja sesiones reales, sin
-- necesidad de una columna de familia nueva.
--
-- Hueco real que si hacía falta cerrar: `refresh_tokens` no guardaba NADA
-- que permitiera reconocer una sesión a simple vista (ver 0017: solo
-- id/user_id/token_hash/expires_at/revoked_at/created_at) -- ip/user-agent
-- se añaden aquí y se pueblan desde `create_refresh_token`/
-- `rotate_refresh_token` (apps/api ya los tenía disponibles vía
-- `auditContext`, solo no se persistían).

alter table refresh_tokens add column if not exists ip_address text;
alter table refresh_tokens add column if not exists user_agent text;

-- ---------------------------------------------------------------------------
-- 1. create_refresh_token / rotate_refresh_token: +ip/user-agent.
--    Se DROPEA la firma vieja (4 parámetros) y se recrea con 6, los dos
--    nuevos con DEFAULT NULL -- así una llamada existente con solo 4
--    argumentos posicionales (packages/db/test/ronda2-extensions.test.ts,
--    req181-mail.test.ts, security-definer-audit.test.ts, ninguno relevante
--    para ip/user-agent) sigue resolviendo a esta MISMA función sin tocar
--    esos archivos, en vez de crear un segundo overload con lógica
--    duplicada. apps/api (el único llamador real en producción, ver
--    modules/auth/routes.ts) sí pasa los 6 argumentos.
-- ---------------------------------------------------------------------------
drop function if exists app.create_refresh_token(uuid, uuid, text, timestamptz);

create or replace function app.create_refresh_token(
  p_id uuid, p_user_id uuid, p_token_hash text, p_expires_at timestamptz,
  p_ip_address text default null, p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- DB-08 (0040): misma exigencia de contexto ya vigente -- no se relaja aquí.
  if app.current_user_id() is null or app.current_user_id() <> p_user_id then
    raise exception 'create_refresh_token_requires_matching_user_context';
  end if;

  insert into refresh_tokens (id, user_id, token_hash, expires_at, ip_address, user_agent)
  values (p_id, p_user_id, p_token_hash, p_expires_at, p_ip_address, p_user_agent);
end;
$$;

drop function if exists app.rotate_refresh_token(text, uuid, text, timestamptz);

create or replace function app.rotate_refresh_token(
  p_old_token_hash text,
  p_new_id uuid,
  p_new_token_hash text,
  p_new_expires_at timestamptz,
  p_ip_address text default null,
  p_user_agent text default null
)
returns table (user_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_reused_user_id uuid;
begin
  -- Sin cambios de fondo respecto a 0043 (ver docstring ahí de por qué NUNCA
  -- usa `raise exception` en el camino de fallo): solo se agregan las dos
  -- columnas nuevas al INSERT de la fila rotada.
  update refresh_tokens
     set revoked_at = now()
   where token_hash = p_old_token_hash
     and revoked_at is null
     and expires_at > now()
  returning refresh_tokens.user_id into v_user_id;

  if v_user_id is null then
    select rt.user_id into v_reused_user_id
      from refresh_tokens rt
     where rt.token_hash = p_old_token_hash
       and rt.revoked_at is not null;

    if v_reused_user_id is not null then
      update refresh_tokens set revoked_at = now()
       where refresh_tokens.user_id = v_reused_user_id and revoked_at is null;
    end if;

    return;
  end if;

  insert into refresh_tokens (id, user_id, token_hash, expires_at, ip_address, user_agent)
  values (p_new_id, v_user_id, p_new_token_hash, p_new_expires_at, p_ip_address, p_user_agent);

  return query select v_user_id;
end;
$$;

revoke execute on function app.create_refresh_token(uuid, uuid, text, timestamptz, text, text) from public;
grant execute on function app.create_refresh_token(uuid, uuid, text, timestamptz, text, text) to app_role;
revoke execute on function app.rotate_refresh_token(text, uuid, text, timestamptz, text, text) from public;
grant execute on function app.rotate_refresh_token(text, uuid, text, timestamptz, text, text) to app_role;

-- ---------------------------------------------------------------------------
-- 2. Listar/cerrar sesiones activas del usuario AUTENTICADO. Igual que el
--    resto de funciones sobre `refresh_tokens` (0017): nadie toca la tabla
--    directamente (RLS habilitada sin políticas) -- todo pasa por estas
--    funciones SECURITY DEFINER, que resuelven el usuario dueño SIEMPRE
--    desde `app.current_user_id()` (nunca de un parámetro de entrada, para
--    no repetir DB-08/DB-01) y exigen que ya esté fijado.
-- ---------------------------------------------------------------------------
create or replace function app.list_active_refresh_tokens()
returns table (id uuid, created_at timestamptz, expires_at timestamptz, ip_address text, user_agent text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_user_id() is null then
    raise exception 'list_active_refresh_tokens_requires_authenticated_context';
  end if;

  return query
    select rt.id, rt.created_at, rt.expires_at, rt.ip_address, rt.user_agent
    from refresh_tokens rt
    where rt.user_id = app.current_user_id()
      and rt.revoked_at is null
      and rt.expires_at > now()
    order by rt.created_at desc;
end;
$$;

-- Cierra UNA sesión concreta del usuario autenticado. `p_id` se filtra
-- SIEMPRE junto con `user_id = app.current_user_id()` -- pedir el id de la
-- sesión de OTRO usuario simplemente no actualiza ninguna fila (0 filas
-- devueltas), nunca revela si ese id existe.
create or replace function app.revoke_refresh_token_by_id(p_id uuid)
returns table (out_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_user_id() is null then
    raise exception 'revoke_refresh_token_by_id_requires_authenticated_context';
  end if;

  return query
    update refresh_tokens
       set revoked_at = now()
     where id = p_id
       and user_id = app.current_user_id()
       and revoked_at is null
    returning refresh_tokens.id;
end;
$$;

-- Cierra TODAS las sesiones activas del usuario autenticado EXCEPTO la que
-- coincide con `p_keep_token_hash` (hash del refresh token que el propio
-- cliente está usando ahora mismo -- ver POST /auth/sessions/revoke-others).
-- Exige que ESA sesión exista, esté activa y sea del usuario actual ANTES
-- de revocar cualquier otra: sin esa comprobación, un `p_keep_token_hash`
-- inventado/ajeno revocaría TODAS las sesiones reales (incluida la que el
-- cliente cree estar preservando), que es exactamente el bug que este check
-- evita -- mismo espíritu que el resto de `apps/api` (nunca confiar en la
-- forma del parámetro por sí sola).
create or replace function app.revoke_other_refresh_tokens(p_keep_token_hash text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_exists boolean;
  v_count integer;
begin
  if app.current_user_id() is null then
    raise exception 'revoke_other_refresh_tokens_requires_authenticated_context';
  end if;

  select exists (
    select 1 from refresh_tokens
    where token_hash = p_keep_token_hash
      and user_id = app.current_user_id()
      and revoked_at is null
      and expires_at > now()
  ) into v_current_exists;

  if not v_current_exists then
    raise exception 'revoke_other_refresh_tokens_current_session_not_found';
  end if;

  with revoked as (
    update refresh_tokens
       set revoked_at = now()
     where user_id = app.current_user_id()
       and revoked_at is null
       and token_hash <> p_keep_token_hash
    returning 1
  )
  select count(*)::integer into v_count from revoked;

  return v_count;
end;
$$;

revoke execute on function app.list_active_refresh_tokens() from public;
grant execute on function app.list_active_refresh_tokens() to app_role;
revoke execute on function app.revoke_refresh_token_by_id(uuid) from public;
grant execute on function app.revoke_refresh_token_by_id(uuid) to app_role;
revoke execute on function app.revoke_other_refresh_tokens(text) from public;
grant execute on function app.revoke_other_refresh_tokens(text) to app_role;

-- ---------------------------------------------------------------------------
-- 3. step_up_sessions: nuevo propósito 'auth.password_change' (mismo patrón
--    que 0091 -- el CHECK a nivel de esquema debe mantenerse sincronizado a
--    mano con STEP_UP_PURPOSES, lib/step-up.ts).
-- ---------------------------------------------------------------------------
alter table step_up_sessions drop constraint if exists chk_step_up_sessions_purpose;
alter table step_up_sessions
  add constraint chk_step_up_sessions_purpose
  check (purpose in (
    'company.rate_approval',
    'expediente.approval',
    'tool_call.approval',
    'admin.action',
    'expediente.contract_transition',
    'expediente.inconformidad_review',
    'twofa.disable',
    'twofa.backup_codes_regenerate',
    'auth.password_change'
  ));

-- ---------------------------------------------------------------------------
-- 4. app.record_auth_event: +3 acciones nuevas (cambio de contraseña propia,
--    cerrar una sesión, cerrar todas menos la actual) -- las tres son
--    POST-autenticación (el actor SIEMPRE coincide con
--    `app.current_user_id()`, igual que `auth.logout`/`auth.refresh_succeeded`).
-- ---------------------------------------------------------------------------
create or replace function app.record_auth_event(
  p_action text,
  p_actor_id uuid,
  p_after jsonb,
  p_request_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_user_id uuid := app.current_user_id();
begin
  if p_action not in (
    'auth.login_succeeded',
    'auth.login_failed',
    'auth.refresh_succeeded',
    'auth.refresh_reuse_detected',
    'auth.logout',
    'auth.google_login',
    'auth.google_linked',
    'auth.google_rejected',
    'auth.email_verification_sent',
    'auth.email_verified',
    'auth.password_reset_requested',
    'auth.password_reset_completed',
    'auth.password_changed',
    'auth.session_revoked',
    'auth.sessions_revoked_others'
  ) then
    raise exception 'record_auth_event_accion_no_permitida: %', p_action;
  end if;

  if p_action not in ('auth.login_failed', 'auth.google_rejected', 'auth.email_verification_sent', 'auth.password_reset_requested') then
    if p_actor_id is null or v_current_user_id is null or v_current_user_id <> p_actor_id then
      raise exception 'record_auth_event_actor_mismatch';
    end if;
  end if;

  insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id)
  values (null, p_actor_id, p_action, 'auth', p_actor_id::text, p_after, p_request_id);
end;
$$;

revoke execute on function app.record_auth_event(text, uuid, jsonb, text) from public;
grant execute on function app.record_auth_event(text, uuid, jsonb, text) to app_role;
