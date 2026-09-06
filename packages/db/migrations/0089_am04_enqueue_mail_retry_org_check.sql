-- 0089_am04_enqueue_mail_retry_org_check.sql
-- AM-04 (docs/auditoria-2/api-mail.md, MEDIA): `app.enqueue_mail_retry`
-- (0086, SECURITY DEFINER) es la ÚNICA función que puede insertar en `jobs`
-- sin pasar por la política `ins_jobs` (0028) -- existe precisamente para
-- bordear esa RLS cuando un correo de verificación/restablecimiento de
-- contraseña no tiene organización NI sesión. El problema encontrado por la
-- auditoría: la función nunca comparaba `p_org_id` contra la organización de
-- la SESIÓN que la invoca. Confirmado en vivo por el auditor: con
-- `app.current_org_id()` fijado a la organización A, se podía pedir encolar
-- el job para la organización B (ajena) sin ningún rechazo -- exactamente el
-- tipo de comprobación que uno esperaría de la función que existe PARA
-- bordear RLS.
--
-- No es explotable HOY: el único invocador real
-- (`apps/api/src/lib/mail/send-transactional.ts`) llama a esta función
-- dentro de su PROPIA transacción nueva (`app.db.transaction`), que solo fija
-- `set local role app_role` -- nunca `app.current_org_id` -- así que
-- `app.current_org_id()` es SIEMPRE NULL en el único call site real de hoy,
-- coincida o no `p_org_id` con la organización de la petición HTTP que
-- disparó el correo (invitación, onboarding, etc. -- ver
-- `apps/api/src/lib/mail/triggers.ts`: `sendOrganizationInviteEmail`/
-- `sendWelcomeOnboardingEmail` pasan `orgId` real sin fijar sesión). Por eso
-- la comprobación de abajo es defensa en profundidad para un FUTURO llamador
-- (o un bug en uno existente) que sí invoque esta función con una sesión de
-- organización activa: en ese caso, y SOLO en ese caso, `p_org_id` debe
-- coincidir exactamente con `app.current_org_id()`, o la función falla con
-- una excepción explícita ANTES de insertar nada. Cuando no hay organización
-- en sesión (el camino real de hoy: verificación de correo, restablecimiento
-- de contraseña, o cualquier llamador que -- como el actual -- no fija
-- contexto de organización), `p_org_id` puede seguir siendo cualquier valor
-- (incluido NULL) sin ninguna comprobación adicional: no hay sesión de la
-- que defender ese valor.
--
-- Se mantiene, sin cambios, la acotación ya existente a `kind = 'mail_retry'`
-- (sigue sin ser parámetro, fijo en el cuerpo del INSERT: ningún llamador
-- puede producir un job de otro tipo por esta vía) y la exigencia de
-- `messageKey` en el payload. `create or replace function` sobre la MISMA
-- firma (`uuid,uuid,jsonb,integer,integer,text`) mantiene la migración
-- idempotente frente al checksum de `schema_migrations`
-- (`packages/db/src/migrate.ts`): reaplicar este archivo sin cambios es un
-- no-op seguro, y cualquier edición posterior de su contenido exige una
-- migración NUEVA, nunca tocar este archivo ya aplicado.
create or replace function app.enqueue_mail_retry(
  p_id uuid,
  p_org_id uuid,
  p_payload jsonb,
  p_delay_seconds integer,
  p_max_attempts integer,
  p_correlation_id text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_payload is null or (p_payload ->> 'messageKey') is null then
    raise exception 'enqueue_mail_retry_payload_sin_messageKey';
  end if;

  -- AM-04: si HAY una organización activa en la sesión que invoca, el job
  -- solo puede encolarse para ESA misma organización -- nunca para otra
  -- distinta ni "sin organización" (p_org_id null tampoco coincide con una
  -- sesión que sí tiene organización). Sin organización en sesión (el
  -- camino real de hoy), no hay nada que comparar: p_org_id sigue sin
  -- restricción adicional aquí (RLS normal de `jobs`/`ins_jobs` no aplica
  -- a esta función por diseño, ver 0086).
  if app.current_org_id() is not null and app.current_org_id() is distinct from p_org_id then
    raise exception 'enqueue_mail_retry_org_mismatch: la sesión activa (org=%) no puede encolar un job mail_retry para otra organización (%)',
      app.current_org_id(), p_org_id;
  end if;

  insert into jobs (id, org_id, kind, payload, status, next_run_at, max_attempts, correlation_id)
  values (
    p_id,
    p_org_id,
    'mail_retry',
    p_payload,
    'queued',
    now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 300), 0)),
    greatest(coalesce(p_max_attempts, 5), 1),
    p_correlation_id
  );
end;
$$;

revoke execute on function app.enqueue_mail_retry(uuid, uuid, jsonb, integer, integer, text) from public;
grant execute on function app.enqueue_mail_retry(uuid, uuid, jsonb, integer, integer, text) to app_role;
