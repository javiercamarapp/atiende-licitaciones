-- 0086_req181_mail_retry_job.sql
-- REQ-188 / S7 (docs/ACEPTACION.md): "envío fallido reintenta vía job y
-- queda registrado con su historial de intentos".
--
-- EL PROBLEMA QUE ARREGLA (encontrado por
-- apps/api/test/mail-provider-and-retry.test.ts, no en revisión):
-- `apps/api/src/lib/mail/send-transactional.ts` encola un job
-- `kind = 'mail_retry'` cuando `MailService` agota sus reintentos internos.
-- Ese INSERT lo hacía directamente como `app_role`, y la política
-- `ins_jobs` (0028_worker_role.sql) solo deja insertar a `worker_role`, a un
-- superadmin, o a un miembro de la organización DUEÑA del job:
--
--   with check (current_user = 'worker_role' or app.is_superadmin()
--               or (org_id = app.current_org_id() and app.has_role(...)))
--
-- Un correo de verificación de cuenta o de restablecimiento de contraseña no
-- tiene organización NI sesión (se manda antes de que exista cualquiera de
-- las dos): `org_id` es NULL y `app.current_org_id()` también, así que la
-- política rechazaba el INSERT con "new row violates row-level security
-- policy for table jobs". Resultado real: justo los correos MÁS críticos
-- eran los únicos que no dejaban rastro reintentable cuando el proveedor
-- fallaba -- un fallo silencioso (la excepción se tragaba en el `.catch` del
-- envío en segundo plano), que es la peor forma de fallar.
--
-- LA CORRECCIÓN: una función SECURITY DEFINER acotada, mismo patrón que
-- `app.record_auth_event` (0051) o `app.mail_outbox_*` (0080) -- inserta sin
-- pasar por RLS, pero SOLO puede crear jobs de este único `kind`, con un
-- payload que ya viene armado por `apps/api`. Nunca un `kind`/`status`
-- arbitrario: relajar `ins_jobs` para permitir `org_id IS NULL` a cualquier
-- `app_role` habría abierto la cola de trabajo entera a cualquier usuario
-- autenticado, que es exactamente lo que esa política existe para impedir.
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
