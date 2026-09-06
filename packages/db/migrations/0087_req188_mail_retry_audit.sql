-- 0087_req188_mail_retry_audit.sql
-- REQ-188 / S7 (docs/ACEPTACION.md): implementa en `apps/worker` el handler
-- del job `kind = 'mail_retry'` que `apps/api` ya encola desde 0086 (ver
-- `apps/api/src/lib/mail/send-transactional.ts` para el contrato del
-- payload). `apps/worker/src/handlers/mail-retry.ts` reutiliza
-- `@atiende/mail`/`app.mail_outbox_*`/`app.mail_suppression_*` (0080/0081,
-- ya aplicadas, ya en la lista blanca de
-- `packages/db/test/security-definer-audit.test.ts`) tal cual para el envío
-- en sí -- esta migración añade las DOS piezas de esquema que faltaban:
-- auditoría (abajo) y la reapertura deliberada de una reserva `dead` (más
-- abajo, `app.mail_outbox_reopen_for_retry`).
--
-- EL PROBLEMA: `audit_log` (0003, RLS habilitada, políticas en 0008) exige
-- `app.is_superadmin()` para INSERT cuando `org_id is null` (0035 la relajó
-- para permitir `org_id null`, pero sigue exigiendo superadmin) -- un job
-- `mail_retry` de un correo de verificación/restablecimiento de contraseña
-- (sin organización, ver 0086) corre como `worker_role`/`app_role`, nunca
-- como superadmin, así que un INSERT directo en `audit_log` desde el
-- handler fallaría la política justo para los correos SIN organización, el
-- mismo patrón de fallo que 0086 corrigió para el INSERT en `jobs`.
--
-- LA CORRECCIÓN: una función SECURITY DEFINER estrecha, mismo patrón que
-- `app.record_auth_event` (0051)/`app.record_security_event` (0057) --
-- inserta en `audit_log` bypassing RLS, pero SOLO para una lista fija de
-- acciones de este único flujo (`entity = 'mail_retry'`), nunca un
-- `action`/`entity`/`org_id` arbitrarios. `p_org_id` es solo metadato
-- informativo (igual que `app.mail_outbox_reserve`, 0080): la tabla
-- `audit_log` en sí sigue existiendo por organización cuando aplica, pero
-- esta función no usa `p_org_id` para decidir nada de RLS.
create or replace function app.record_mail_retry_event(
  p_action text,
  p_org_id uuid,
  p_entity_id text,
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
    'mail_retry.sent',
    'mail_retry.already_sent',
    'mail_retry.skipped_preferences',
    'mail_retry.suppressed',
    'mail_retry.dead_permanent',
    'mail_retry.dead',
    'mail_retry.malformed_payload'
  ) then
    raise exception 'record_mail_retry_event_accion_no_permitida: %', p_action;
  end if;

  insert into audit_log (org_id, actor_id, action, entity, entity_id, after, request_id)
  values (p_org_id, null, p_action, 'mail_retry', p_entity_id, p_after, p_request_id);
end;
$$;

revoke execute on function app.record_mail_retry_event(text, uuid, text, jsonb, text) from public;
grant execute on function app.record_mail_retry_event(text, uuid, text, jsonb, text) to app_role;

-- ---------------------------------------------------------------------------
-- app.mail_outbox_reopen_for_retry: reabre deliberadamente una reserva
-- `dead` para el ÚNICO caso que puede necesitarlo (el job `mail_retry`).
--
-- EL PROBLEMA (encontrado al implementar el handler, no en revisión): una
-- vez que `mail_outbox.status = 'dead'` (0080: "se agotaron los
-- reintentos, no se vuelve a intentar solo" -- ver el docstring de
-- `SendStatus` en `packages/mail/src/service/send-store.ts`), NINGUNA
-- función existente de 0080 puede des-marcarla. `mail_outbox_save()` solo
-- ACEPTA escribir un estado terminal (nunca 'pending'), y
-- `mail_outbox_reserve()`/`mail_outbox_release()` solo tocan filas
-- `status = 'pending'` en su `WHERE`/`ON CONFLICT ... WHERE` -- una fila
-- `dead` no cumple esa condición nunca, así que `INSERT ... ON CONFLICT DO
-- UPDATE ... WHERE status = 'pending'` no actualiza nada y
-- `mail_outbox_reserve()` devuelve `NULL` (reserva perdida) para SIEMPRE en
-- esa `dedupe_key`. Sin esta función, volver a llamar
-- `MailService.send()` con la MISMA `messageKey` desde `apps/worker`
-- jamás volvería a tocar el proveedor: `send()` vería `reserve() = false`,
-- esperaría el registro "en vuelo" (`waitForReservedRecord`), lo
-- encontraría YA `dead` de inmediato, y devolvería `dead` otra vez sin
-- reintentar nunca -- el job `mail_retry` habría sido, en la práctica, un
-- no-op perpetuo, exactamente lo opuesto de REQ-188.
--
-- LA CORRECCIÓN: SOLO transiciona 'dead' -> 'pending' (retrocediendo
-- `updated_at`, mismo criterio de "ventana de staleness" de 60s que
-- `mail_outbox_release`, 0080, para que `mail_outbox_reserve()` la pueda
-- reclamar de inmediato). Nunca toca 'sent' (el correo YA se mandó -- una
-- fila 'sent' simplemente no cumple `status = 'dead'` en el `WHERE`, así
-- que esta función es un no-op seguro sobre ella, y `MailService.send()`
-- la seguirá viendo como `already_sent` en su primer `get()`) ni
-- 'failed_permanent' (MailService ya clasificó ese error como
-- NO-reintentable, WK-10 -- reabrir esa fila reintentaría un rechazo del
-- proveedor que nunca cambiará, exactamente el desperdicio que WK-10 evita
-- a nivel de `jobs`). El llamador (`apps/worker/src/handlers/
-- mail-retry.ts`) la invoca ANTES de cada llamada a `MailService.send()`;
-- es idempotente (un `dedupe_key` que ya no está `dead` -- porque no
-- existe, porque ya es `pending`, `sent` o `failed_permanent` -- deja 0
-- filas actualizadas, sin error).
create or replace function app.mail_outbox_reopen_for_retry(p_dedupe_key text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  update mail_outbox
    set status = 'pending', updated_at = now() - interval '61 seconds'
    where dedupe_key = p_dedupe_key and status = 'dead'
  returning true
$$;

revoke execute on function app.mail_outbox_reopen_for_retry(text) from public;
grant execute on function app.mail_outbox_reopen_for_retry(text) to app_role;
