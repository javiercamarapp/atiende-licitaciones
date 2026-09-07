-- 0091_e21_twofa_disable_backup_regenerate.sql
-- E21 (docs/BACKLOG.md): dos acciones nuevas de cuenta, ambas exigen
-- step-up (2FA reciente) igual que el resto de `apps/api`
-- (`lib/step-up.ts#STEP_UP_PURPOSES`):
--   - `twofa.disable`: desactivar 2FA de la cuenta propia (borra
--     `user_totp_secrets`/`user_backup_codes`, ver `modules/twofa/routes.ts`).
--   - `twofa.backup_codes_regenerate`: regenerar códigos de respaldo
--     (invalida por completo los anteriores).
-- Mismo patrón que 0063/0066: el CHECK a nivel de esquema debe mantenerse
-- sincronizado a mano con `STEP_UP_PURPOSES` (lib/step-up.ts).
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
    'twofa.backup_codes_regenerate'
  ));

-- Misma función SECURITY DEFINER (0057/0059) -- se amplía la lista blanca
-- de `p_action` con los dos eventos nuevos, y la de `p_entity` con
-- `user_backup_codes` (entidad auditada por `twofa.backup_codes_regenerated`;
-- `twofa.disabled` reusa `user_totp_secrets`, ya permitida).
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
    'twofa.verification_failed', 'twofa.step_up_denied',
    'twofa.disabled', 'twofa.backup_codes_regenerated'
  ) then
    raise exception 'record_security_event_accion_no_permitida: %', p_action;
  end if;
  if p_entity not in ('user_totp_secrets', 'step_up_sessions', 'user_backup_codes') then
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
