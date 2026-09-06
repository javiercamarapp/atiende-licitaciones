-- 0059_r503_twofa_failure_audit.sql
-- R5-03 (docs/auditoria-2/api-ronda5.md, MEDIA): `recordSecurityAudit`
-- (app.record_security_event, 0057) solo se invocaba en las ramas de ÉXITO
-- de `modules/twofa/routes.ts` -- ninguna rama de error (código inválido,
-- replay, backup code ya usado, cuenta bloqueada) quedaba en `audit_log`,
-- rompiendo la paridad que la ronda 4 (API-13, 0051) ya estableció para
-- `/auth/login` (`auth.login_failed` sí se audita). Sin ese rastro, un
-- ataque de fuerza bruta contra el 2FA es indetectable en retrospectiva --
-- agrava R5-02 (sin límite de tasa NI auditoría de fallos).
--
-- Misma función SECURITY DEFINER (0057), MISMA firma
-- (app.record_security_event(text,uuid,text,text,jsonb,text,text)) --
-- solo se amplía la lista blanca de `p_action` con los dos eventos de
-- fallo. `p_entity` sigue restringido a las mismas dos entidades y la
-- exigencia de que `p_actor_id` coincida con `app.current_user_id()`
-- (sin excepción, ver 0057) no cambia.
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
  if p_action not in (
    'twofa.enroll', 'twofa.verify_enrollment', 'twofa.step_up_verified',
    'twofa.verification_failed', 'twofa.step_up_denied'
  ) then
    raise exception 'record_security_event_accion_no_permitida: %', p_action;
  end if;
  if p_entity not in ('user_totp_secrets', 'step_up_sessions') then
    raise exception 'record_security_event_entidad_no_permitida: %', p_entity;
  end if;
  if p_actor_id is distinct from app.current_user_id() then
    raise exception 'record_security_event_actor_no_coincide';
  end if;

  insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id, correlation_id)
  values (null, p_actor_id, p_action, p_entity, p_entity_id, p_after, p_request_id, p_correlation_id);
end;
$$;

revoke execute on function app.record_security_event(text, uuid, text, text, jsonb, text, text) from public;
grant execute on function app.record_security_event(text, uuid, text, text, jsonb, text, text) to app_role;
