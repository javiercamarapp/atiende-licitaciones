-- 0051_fix_api13_auth_audit_log.sql
-- Corrige API-13 (BAJA/MEDIA, nuevo) --
-- docs/auditoria-1/db-api-seguridad-reverificacion.md:
--
-- `apps/api/src/modules/auth/routes.ts` (login, refresh, logout) nunca
-- llamaba a `recordAudit` -- en particular, la revocación defensiva de
-- TODA la familia de sesiones activas que dispara la detección de reuso de
-- un refresh token (API-01, `app.rotate_refresh_token`, 0043) no dejaba
-- ningún rastro en `audit_log`. Un evento de seguridad genuino (sospecha
-- de robo de refresh token) era invisible para el back office/superadmin.
--
-- Los eventos de autenticación ocurren ANTES de que exista contexto de
-- organización (`org_id` no aplica) y el actor casi nunca es superadmin --
-- la política RLS de `audit_log` (0008, relajada en 0035 para permitir
-- `org_id is null`) solo autoriza ese INSERT cuando `app.is_superadmin()`
-- es verdadero. Un INSERT directo de `apps/api` con `org_id: null` para un
-- login/refresh/logout de un usuario normal fallaría la política RLS.
--
-- Corrección: una función `SECURITY DEFINER` estrecha (mismo patrón que
-- `app.create_refresh_token`/`app.rotate_refresh_token` ya usan para
-- escribir en `refresh_tokens`, tabla con RLS habilitada SIN políticas)
-- que inserta en `audit_log` bypassing RLS -- pero SOLO para una lista
-- fija de acciones de autenticación conocidas (nunca una `action`/`entity`/
-- `org_id` arbitrarios): "auth.login_succeeded", "auth.login_failed",
-- "auth.refresh_succeeded", "auth.refresh_reuse_detected", "auth.logout".
-- El `after` que reciba NUNCA debe incluir contraseñas ni tokens (lo
-- impone la aplicación, ver lib/audit.ts `recordAuthAudit`).

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
begin
  if p_action not in (
    'auth.login_succeeded',
    'auth.login_failed',
    'auth.refresh_succeeded',
    'auth.refresh_reuse_detected',
    'auth.logout'
  ) then
    raise exception 'record_auth_event_accion_no_permitida: %', p_action;
  end if;

  insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id)
  values (null, p_actor_id, p_action, 'auth', p_actor_id::text, p_after, p_request_id);
end;
$$;

revoke execute on function app.record_auth_event(text, uuid, jsonb, text) from public;
grant execute on function app.record_auth_event(text, uuid, jsonb, text) to app_role;
