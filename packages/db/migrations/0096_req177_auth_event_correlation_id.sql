-- 0096_req177_auth_event_correlation_id.sql
-- REQ-177 (docs/ACEPTACION.md): brecha honesta detectada por el auditor --
-- `recordAuthAudit` (apps/api/src/lib/audit.ts) nunca pasaba
-- `correlationId` a `app.record_auth_event` (0051, extendida en
-- 0054/0072/0084/0092/0093), así que `audit_log.correlation_id` quedaba
-- SIEMPRE NULL para todo evento de autenticación -- login, refresh,
-- logout, Google (login/vinculación/rechazo/desvinculación), verificación
-- de correo y restablecimiento de contraseña -- con paridad exacta entre
-- Google y email+contraseña (ninguno de los dos lo llenaba).
--
-- `app.record_security_event` (0057) YA recibe `p_correlation_id` desde su
-- creación -- este cambio simplemente alinea `record_auth_event` al mismo
-- patrón, para que `GET /audit-log?correlationId=` (REQ-171) también
-- pueda reconstruir un flujo que arranca o pasa por un evento de
-- autenticación (p.ej. "Google login -> onboarding -> primera
-- convocatoria"), igual que ya hace con el resto de `apps/api`.
--
-- `p_correlation_id` tiene DEFAULT null (no una nueva sobrecarga): mismo
-- criterio de compatibilidad que cualquier llamador SQL directo existente
-- (incl. las pruebas de packages/db que invocan la función con 4
-- argumentos posicionales) sigue funcionando sin cambios -- se hace
-- `drop function` primero (mismo patrón que 0085/0092 al cambiar la firma
-- de una función SECURITY DEFINER existente) para que no queden DOS
-- sobrecargas (4 y 5 argumentos) ambiguas conviviendo en el catálogo.
drop function if exists app.record_auth_event(text, uuid, jsonb, text);

create or replace function app.record_auth_event(
  p_action text,
  p_actor_id uuid,
  p_after jsonb,
  p_request_id text,
  p_correlation_id text default null
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
    'auth.google_unlinked',
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

  insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id, correlation_id)
  values (null, p_actor_id, p_action, 'auth', p_actor_id::text, p_after, p_request_id, p_correlation_id);
end;
$$;

revoke execute on function app.record_auth_event(text, uuid, jsonb, text, text) from public;
grant execute on function app.record_auth_event(text, uuid, jsonb, text, text) to app_role;
