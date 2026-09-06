-- 0072_req177_google_auth_audit.sql
-- REQ-177: todo login, vinculación o creación de cuenta vía Google queda
-- registrado en `audit_log` con el mismo detalle (ip, resultado,
-- correlation_id vía `request_id`) que el flujo de email+contraseña.
--
-- Extiende `app.record_auth_event` (0051, endurecida en 0054 tras API-14)
-- con tres acciones nuevas:
--   - auth.google_login: login exitoso (identidad ya vinculada, o recién
--     vinculada/creada en la MISMA operación) -- requiere sesión YA fijada
--     (`app.current_user_id()` = `p_actor_id`), igual que
--     auth.login_succeeded.
--   - auth.google_linked: se vinculó una cuenta EXISTENTE (email+contraseña
--     previo) a una identidad de Google nueva -- mismo requisito de sesión
--     fijada que google_login (se emite en la MISMA transacción, ya con el
--     `user_id` verificado).
--   - auth.google_rejected: rechazo explícito ANTES de que exista ninguna
--     sesión real (`email_verified=false` -- REQ-179; `aud`/`iss`/`exp`/
--     `nonce` inválidos; conflicto de vinculación -- REQ-180; state/nonce
--     inválido, expirado o reutilizado). Es el equivalente exacto de
--     `auth.login_failed` para este flujo: el actor puede ser NULL (nunca
--     se determinó qué cuenta, o ninguna cuenta real está involucrada) o
--     el id de una cuenta existente cuya vinculación se rechazó -- en
--     NINGÚN caso hay una identidad de sesión que fijar antes de auditar,
--     así que (igual que login_failed) esta acción se exceptúa del
--     candado de coincidencia de actor.
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
    'auth.google_rejected'
  ) then
    raise exception 'record_auth_event_accion_no_permitida: %', p_action;
  end if;

  if p_action not in ('auth.login_failed', 'auth.google_rejected') then
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
