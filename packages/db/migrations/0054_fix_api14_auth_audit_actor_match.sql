-- 0054_fix_api14_auth_audit_actor_match.sql
-- Corrige API-14 (docs/auditoria-2/api-expediente-reverificacion.md,
-- BAJA/MEDIA): `app.record_auth_event` (0051) es SECURITY DEFINER,
-- concedida a `app_role` -- que usan TODAS las transacciones de esta API,
-- no solo las de autenticación -- y aceptaba `p_actor_id` como parámetro
-- SIN verificarlo contra ninguna identidad de sesión real. Cualquier
-- código que corriera como `app_role` (p. ej. vía un bug de inyección SQL
-- en otra parte, o un futuro llamador descuidado) podía forjar un evento
-- de auditoría de autenticación atribuido a un `actor_id` arbitrario --
-- mismo patrón de fondo que DB-01/DB-08 (una función SECURITY DEFINER
-- nunca debe confiar en un parámetro de identidad sin verificar).
--
-- Corrección: exige que `p_actor_id` coincida con `app.current_user_id()`
-- YA fijado por el llamador, EXCEPTO para `auth.login_failed` -- el único
-- evento genuinamente PRE-AUTENTICACIÓN (todavía no existe ninguna sesión:
-- el actor puede ser NULL si el email ni siquiera existe, o el id de una
-- cuenta cuya contraseña acaba de fallar -- en ningún caso hay una
-- identidad de sesión que fijar). El resto de acciones
-- (login_succeeded/refresh_succeeded/refresh_reuse_detected/logout) SÍ
-- tienen una identidad ya verificada disponible en ese punto del código
-- (contraseña recién validada, o el `user_id` que devuelve
-- `rotate_refresh_token`/`find_refresh_token`, o el `sub` de un JWT
-- firmado por el propio servidor) -- `apps/api` (src/modules/auth/routes.ts)
-- se actualiza en el mismo cambio para fijar `app.current_user_id` con
-- ese valor YA verificado antes de llamar a `record_auth_event` en los
-- tres casos que todavía no lo hacían.
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
    'auth.logout'
  ) then
    raise exception 'record_auth_event_accion_no_permitida: %', p_action;
  end if;

  if p_action <> 'auth.login_failed' then
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
