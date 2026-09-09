-- 0093_e19_google_unlink.sql
-- E19/E21 (docs/BACKLOG.md): desvincular la identidad de Google de la
-- propia cuenta (`POST /auth/google/unlink`, ver
-- `modules/auth/google/unlink.routes.ts`). Exige step-up (2FA reciente,
-- mismo `requireStepUp` que el resto de `apps/api`, purpose
-- `auth.google_unlink`) y, como el resto de esta familia de acciones
-- (`twofa.disable`, 0091), NUNCA deja la cuenta sin ningún método de
-- acceso: se rechaza con 409 si la cuenta no tiene contraseña propia
-- (`users.password_hash is null` -- caso de una cuenta creada por Google,
-- REQ-174, que nunca puso una).
--
-- `user_identities` (0071) tenía RLS habilitada con políticas de SELECT/
-- INSERT únicamente -- nunca hubo un DELETE hasta ahora (ninguna acción
-- anterior lo necesitaba). Sin una política de DELETE explícita, Postgres
-- rechaza en SILENCIO cualquier intento de borrar (0 filas afectadas, sin
-- error) -- se agrega aquí, mismo patrón que `del_user_totp_secrets`/
-- `del_user_backup_codes` (0057): cada usuario solo puede borrar SU PROPIA
-- fila.
drop policy if exists del_user_identities on user_identities;
create policy del_user_identities on user_identities for delete using (user_id = app.current_user_id());

-- Mismo patrón que 0091/0092: el CHECK a nivel de esquema debe mantenerse
-- sincronizado a mano con STEP_UP_PURPOSES (lib/step-up.ts).
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
    'auth.password_change',
    'auth.google_unlink'
  ));

-- app.record_auth_event: +1 acción nueva (`auth.google_unlinked`, espejo de
-- `auth.google_linked` ya existente desde 0072) -- POST-autenticación, el
-- actor SIEMPRE coincide con app.current_user_id() (misma rama que
-- `auth.password_changed`/`auth.session_revoked`, nunca la de las
-- pre-sesión eximidas más abajo).
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

  insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id)
  values (null, p_actor_id, p_action, 'auth', p_actor_id::text, p_after, p_request_id);
end;
$$;

revoke execute on function app.record_auth_event(text, uuid, jsonb, text) from public;
grant execute on function app.record_auth_event(text, uuid, jsonb, text) to app_role;
