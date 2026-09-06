-- 0084_req_email_verification_and_password_reset.sql
-- REQ-181..195 (docs/REQUISITOS.md §34.2) + paridad Ronda G
-- (docs/investigacion/paridad-producto.md, recuperación de contraseña):
-- verificación de correo al registrarse y restablecimiento de contraseña
-- con token de un solo uso.
--
-- users.email_verified_at: NULL hasta que se consume un
-- email_verification_tokens válido (o, para una cuenta creada vía Google,
-- se fija a `now()` en el momento de la creación -- REQ-179, Google ya
-- verificó ese correo). `apps/api` (`modules/auth/routes.ts`, login)
-- bloquea el login por email+contraseña mientras sea NULL, salvo que la
-- cuenta se haya creado exclusivamente vía Google (password_hash is null
-- -- ese login pasa siempre por /auth/google, nunca por /auth/login).
alter table users add column if not exists email_verified_at timestamptz;

-- email_verification_tokens / password_reset_tokens: mismo patrón que
-- oauth_states (0071) -- contexto ANÓNIMO (quien consume el enlace todavía
-- no tiene sesión), de un solo uso real (`consumed_at`), con TTL
-- (`expires_at`). RLS habilitada SIN políticas: todo acceso vía las
-- funciones SECURITY DEFINER de abajo.
create table if not exists email_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists ix_email_verification_tokens_user on email_verification_tokens (user_id);

alter table email_verification_tokens enable row level security;

create table if not exists password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists ix_password_reset_tokens_user on password_reset_tokens (user_id);

alter table password_reset_tokens enable row level security;

-- ---------------------------------------------------------------------------
-- Verificación de correo
-- ---------------------------------------------------------------------------
create or replace function app.create_email_verification_token(
  p_id uuid, p_user_id uuid, p_token_hash text, p_expires_at timestamptz
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into email_verification_tokens (id, user_id, token_hash, expires_at)
  values (p_id, p_user_id, p_token_hash, p_expires_at)
$$;

-- Consumo atómico de un solo uso (mismo patrón check-y-mutación que
-- app.consume_oauth_state, 0071): un UPDATE ... WHERE consumed_at IS NULL
-- AND expires_at > now() RETURNING garantiza que, bajo concurrencia, como
-- mucho una petición gane el consumo. Marca `users.email_verified_at`
-- dentro de la MISMA función (bypass de RLS deliberado y acotado -- el
-- usuario todavía no tiene sesión para que la política normal de UPDATE de
-- `users` lo permitiera) -- `coalesce` deja intacta una verificación previa
-- (reintento del mismo enlace tras ya haber verificado, o dos pestañas).
create or replace function app.consume_email_verification_token(p_token_hash text)
returns table (out_user_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  update email_verification_tokens
    set consumed_at = now()
    where token_hash = p_token_hash and consumed_at is null and expires_at > now()
    returning user_id into v_user_id;

  if v_user_id is null then
    return;
  end if;

  update users set email_verified_at = coalesce(email_verified_at, now()) where id = v_user_id;

  out_user_id := v_user_id;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- Restablecimiento de contraseña
-- ---------------------------------------------------------------------------
create or replace function app.create_password_reset_token(
  p_id uuid, p_user_id uuid, p_token_hash text, p_expires_at timestamptz
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into password_reset_tokens (id, user_id, token_hash, expires_at)
  values (p_id, p_user_id, p_token_hash, p_expires_at)
$$;

-- Consumo atómico + cambio de contraseña + revocación de TODAS las
-- sesiones (refresh tokens) del usuario, todo en una sola función SECURITY
-- DEFINER (mismo motivo que consume_email_verification_token: sin sesión
-- todavía). `app.revoke_all_refresh_tokens` ya existía (0017,
-- REQ-044/064 nunca la había usado hasta ahora) -- se reutiliza tal cual,
-- sin reimplementar la revocación de familia. El access token (JWT sin
-- estado, 15 min de vigencia) NO se puede revocar server-side sin una
-- lista de bloqueo -- limitación documentada, igual de criterio que el
-- resto de este proyecto: expira solo en <=15 min, y ningún refresh
-- vigente puede ya renovarlo.
create or replace function app.reset_password_with_token(p_token_hash text, p_new_password_hash text)
returns table (out_user_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
begin
  update password_reset_tokens
    set consumed_at = now()
    where token_hash = p_token_hash and consumed_at is null and expires_at > now()
    returning user_id into v_user_id;

  if v_user_id is null then
    return;
  end if;

  update users set password_hash = p_new_password_hash where id = v_user_id;
  perform app.revoke_all_refresh_tokens(v_user_id);

  out_user_id := v_user_id;
  return next;
end;
$$;

revoke execute on function app.create_email_verification_token(uuid, uuid, text, timestamptz) from public;
grant execute on function app.create_email_verification_token(uuid, uuid, text, timestamptz) to app_role;
revoke execute on function app.consume_email_verification_token(text) from public;
grant execute on function app.consume_email_verification_token(text) to app_role;
revoke execute on function app.create_password_reset_token(uuid, uuid, text, timestamptz) from public;
grant execute on function app.create_password_reset_token(uuid, uuid, text, timestamptz) to app_role;
revoke execute on function app.reset_password_with_token(text, text) from public;
grant execute on function app.reset_password_with_token(text, text) to app_role;

-- ---------------------------------------------------------------------------
-- Extiende app.record_auth_event (0051, endurecida en 0054, extendida en
-- 0072) con las acciones de verificación de correo / restablecimiento de
-- contraseña. `email_verification_sent`/`password_reset_requested` son
-- PRE-AUTENTICACIÓN (igual que auth.login_failed/auth.google_rejected):
-- nunca hay una sesión que fijar (el registro/forgot-password son
-- anónimos), así que se exceptúan del candado de coincidencia de actor.
-- `email_verified`/`password_reset_completed` SÍ tienen una identidad ya
-- verificada en ese punto (el `user_id` que devuelven las funciones de
-- consumo de arriba) -- `apps/api` fija `app.current_user_id` a ese valor
-- antes de auditar, igual que auth.google_linked.
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
    'auth.password_reset_completed'
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
