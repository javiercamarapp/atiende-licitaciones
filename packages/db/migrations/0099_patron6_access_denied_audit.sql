-- 0099_patron6_access_denied_audit.sql
-- Patrón Likida/atiende.ai #6 (auditoría del intento de acceso denegado
-- por rol): el mapa explícito de qué ruta puede ver cada rol YA existe y
-- YA se refuerza en la aplicación además de RLS -- `app.membership_role`/
-- `app.is_superadmin` en la base, `requireOrgRole`/`APPROVER_ROLES`/
-- `MEMBERSHIP_ADMIN_ROLES` en `apps/api`. Lo que faltaba era la mitad de
-- "con auditoría del intento denegado": ningún `ForbiddenError` (403)
-- dejaba rastro en `audit_log`, solo el log efímero de la request
-- (`request.log`).
--
-- `apps/api/src/plugins/error-handler.ts` centraliza el registro para
-- TODO `AppError` con `statusCode === 403`, sin tocar cada ruta que lanza
-- `ForbiddenError` (ver ese archivo y `lib/audit.ts::recordAccessDenied`).
-- Ese manejador corre FUERA de cualquier transacción de negocio -- de
-- hecho el caso más interesante ocurre precisamente porque la ruta NUNCA
-- llegó a abrir una: `app.requireOrg` deniega con "no eres miembro de
-- esta organización" ANTES de que exista contexto de org, y
-- `app.requireSuperadmin` deniega EXACTAMENTE cuando `app.is_superadmin()`
-- es falso. Un INSERT normal contra `audit_log` (política `ins_audit_log`,
-- 0008: exige `org_id = app.current_org_id() and app.has_role(...)`, o
-- `app.is_superadmin()`) fallaría por RLS en ambos casos -- el actor NO es
-- miembro de `p_org_id` ni superadmin, que es JUSTO la razón por la que se
-- le denegó el acceso. Mismo problema que API-13 (0051) tuvo con los
-- eventos de autenticación; misma solución: una función `SECURITY DEFINER`
-- estrecha que bypassa RLS, restringida a `action = 'access.denied'` fijo
-- (nunca una `action`/`entity` arbitrarios que pudieran usarse para
-- fabricar auditoría de otro tipo).
--
-- Verifica que quien llama es realmente el actor que dice ser -- mismo
-- patrón que `app.record_auth_event` (0051/0096) y
-- `app.record_security_event` (0057): `p_actor_id` debe coincidir con
-- `app.current_user_id()`, fijado por el llamador vía
-- `set_config('app.current_user_id', ..., true)` en la MISMA transacción
-- -- así ningún actor con `app_role` puede registrar un acceso denegado
-- atribuido a otro usuario.
create or replace function app.record_access_denied_event(
  p_actor_id uuid,
  p_org_id uuid,
  p_entity text,
  p_request_id text,
  p_correlation_id text default null,
  p_detail jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_actor_id is distinct from app.current_user_id() then
    raise exception 'record_access_denied_event_actor_no_coincide';
  end if;

  -- `p_entity` es la ruta HTTP denegada (`request.url`) -- no una tabla de
  -- dominio como en `recordAudit` normal -- por eso `entity_id` queda NULL:
  -- la ruta ya identifica el recurso por completo (incluye cualquier :id de
  -- path param), y la línea de `audit_log` es sobre el INTENTO, no sobre la
  -- fila de negocio a la que apuntaba.
  insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id, correlation_id)
  values (p_org_id, p_actor_id, 'access.denied', p_entity, null, p_detail, p_request_id, p_correlation_id);
end;
$$;

revoke execute on function app.record_access_denied_event(uuid, uuid, text, text, text, jsonb) from public;
grant execute on function app.record_access_denied_event(uuid, uuid, text, text, text, jsonb) to app_role;
