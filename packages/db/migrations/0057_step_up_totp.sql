-- 0057_step_up_totp.sql
-- REQ-044/064: 2FA/step-up (TOTP, otplib) exigido en la aprobación
-- económica de tarifas y en la aprobación de expediente, distinto del rol
-- que aprueba (REQ-064: "re-autenticación... por rol distinto"). Tablas
-- por USUARIO (no por organización -- un usuario enrola 2FA una sola vez,
-- válido en cualquier organización de la que sea miembro), con RLS que
-- solo permite a cada usuario ver/gestionar SU PROPIO secreto/códigos de
-- respaldo/sesiones de verificación (basado en app.current_user_id()).

create table if not exists user_totp_secrets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users (id) on delete cascade,
  -- AES-256-GCM: base64(iv(12) || authTag(16) || ciphertext). Cifrado con
  -- una clave derivada de TOTP_ENCRYPTION_KEY (ver src/lib/step-up.ts) --
  -- nunca se guarda el secreto TOTP en claro.
  secret_ciphertext text not null,
  enrolled_at timestamptz not null default now(),
  -- NULL hasta que el usuario confirma el enrolamiento con un código válido
  -- (POST /auth/2fa/verify-enrollment); un secreto sin verificar nunca
  -- habilita step-up (evita que alguien "enrole" sin de verdad tener acceso
  -- a la app autenticadora).
  verified_at timestamptz,
  -- REQ replay de TOTP rechazado: último "time step" (contador de 30s)
  -- aceptado para este usuario -- un código de un time_step <= al último
  -- aceptado se rechaza SIEMPRE, aunque siga siendo criptográficamente
  -- válido dentro de su ventana de tolerancia.
  last_used_time_step bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_user_totp_secrets_updated_at on user_totp_secrets;
create trigger trg_user_totp_secrets_updated_at
  before update on user_totp_secrets
  for each row execute function app.set_updated_at();

create table if not exists user_backup_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  -- sha256 hex del código de respaldo -- el código en claro se muestra UNA
  -- sola vez al enrolar y nunca se vuelve a poder leer.
  code_hash text not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, code_hash)
);

create index if not exists ix_user_backup_codes_user on user_backup_codes (user_id);

create table if not exists step_up_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  verified_at timestamptz not null default now(),
  -- Ventana configurable (STEP_UP_WINDOW_MINUTES, default 5 min): una
  -- aprobación económica sensible exige un `step_up_sessions` propio,
  -- vigente (expires_at > now()), referenciado por el cliente vía el
  -- encabezado `X-Step-Up: <id>`.
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists ix_step_up_sessions_user on step_up_sessions (user_id, expires_at desc);

alter table user_totp_secrets enable row level security;
alter table user_backup_codes enable row level security;
alter table step_up_sessions enable row level security;

drop policy if exists sel_user_totp_secrets on user_totp_secrets;
create policy sel_user_totp_secrets on user_totp_secrets for select using (user_id = app.current_user_id());
drop policy if exists ins_user_totp_secrets on user_totp_secrets;
create policy ins_user_totp_secrets on user_totp_secrets for insert with check (user_id = app.current_user_id());
drop policy if exists upd_user_totp_secrets on user_totp_secrets;
create policy upd_user_totp_secrets on user_totp_secrets for update using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
drop policy if exists del_user_totp_secrets on user_totp_secrets;
create policy del_user_totp_secrets on user_totp_secrets for delete using (user_id = app.current_user_id());

drop policy if exists sel_user_backup_codes on user_backup_codes;
create policy sel_user_backup_codes on user_backup_codes for select using (user_id = app.current_user_id());
drop policy if exists ins_user_backup_codes on user_backup_codes;
create policy ins_user_backup_codes on user_backup_codes for insert with check (user_id = app.current_user_id());
drop policy if exists upd_user_backup_codes on user_backup_codes;
create policy upd_user_backup_codes on user_backup_codes for update using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
drop policy if exists del_user_backup_codes on user_backup_codes;
create policy del_user_backup_codes on user_backup_codes for delete using (user_id = app.current_user_id());

-- ---------------------------------------------------------------------------
-- Auditoría de eventos de 2FA (mismo patrón que app.record_auth_event,
-- 0051): enrolar/verificar/step-up ocurren sin organización activa (son
-- credenciales de USUARIO, no de organización) y el actor casi nunca es
-- superadmin -- la política RLS de audit_log (0008, org_id nullable desde
-- 0035) solo permite `org_id is null` cuando `app.is_superadmin()`. Una
-- función SECURITY DEFINER estrecha, restringida a una lista fija de
-- acciones/entidades de 2FA conocidas (nunca action/entity arbitrarios),
-- resuelve lo mismo que 0051 resolvió para auth.*.
-- ---------------------------------------------------------------------------
create or replace function app.record_security_event(
  p_action text,
  p_actor_id uuid,
  p_entity text,
  p_entity_id text,
  p_after jsonb,
  p_request_id text,
  p_correlation_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_action not in ('twofa.enroll', 'twofa.verify_enrollment', 'twofa.step_up_verified') then
    raise exception 'record_security_event_accion_no_permitida: %', p_action;
  end if;
  if p_entity not in ('user_totp_secrets', 'step_up_sessions') then
    raise exception 'record_security_event_entidad_no_permitida: %', p_entity;
  end if;
  -- API-14 (0054) aplicó esta misma regla a app.record_auth_event: a
  -- diferencia de login/refresh (que pueden ocurrir SIN sesión previa),
  -- toda acción de 2FA ocurre SIEMPRE con una sesión ya autenticada -- se
  -- exige sin excepción que p_actor_id coincida con app.current_user_id(),
  -- para que un llamador con app_role nunca pueda forjar un evento
  -- atribuido a un actor_id arbitrario.
  if p_actor_id is distinct from app.current_user_id() then
    raise exception 'record_security_event_actor_no_coincide';
  end if;

  insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id, correlation_id)
  values (null, p_actor_id, p_action, p_entity, p_entity_id, p_after, p_request_id, p_correlation_id);
end;
$$;

revoke execute on function app.record_security_event(text, uuid, text, text, jsonb, text, text) from public;
grant execute on function app.record_security_event(text, uuid, text, text, jsonb, text, text) to app_role;

drop policy if exists sel_step_up_sessions on step_up_sessions;
create policy sel_step_up_sessions on step_up_sessions for select using (user_id = app.current_user_id());
drop policy if exists ins_step_up_sessions on step_up_sessions;
create policy ins_step_up_sessions on step_up_sessions for insert with check (user_id = app.current_user_id());
drop policy if exists upd_step_up_sessions on step_up_sessions;
create policy upd_step_up_sessions on step_up_sessions for update using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
drop policy if exists del_step_up_sessions on step_up_sessions;
create policy del_step_up_sessions on step_up_sessions for delete using (user_id = app.current_user_id());
