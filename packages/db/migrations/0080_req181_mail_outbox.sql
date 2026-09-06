-- 0080_req181_mail_outbox.sql
-- REQ-181..195 (docs/REQUISITOS.md §34.2, docs/AMPLIACION-2-SALIDA.md §2):
-- outbox transaccional persistente para @atiende/mail. Implementa el
-- contrato `SendRecordStore` que packages/mail/README.md describe
-- (`apps/api/src/lib/mail/pg-send-record-store.ts`), con la MISMA
-- semántica de reserva atómica (`reserve()`/`release()`, ML-01) documentada
-- ahí: `dedupe_key` único + `INSERT ... ON CONFLICT DO NOTHING` para que dos
-- llamadas concurrentes con la misma `messageKey` (reintento de una cola
-- at-least-once, doble clic) nunca dupliquen un envío real.
--
-- Diseño de estados (`mail_outbox.status`):
--   'pending'         -- reservado por reserve(), sin resultado final todavía
--                         (equivalente a la reserva "solo en memoria" de
--                         InMemorySendRecordStore, pero materializada como
--                         fila real para que sea inspeccionable -- p.ej.
--                         REQ "sin proveedor configurado -> outbox en
--                         pending").
--   'sent'/'failed_permanent'/'dead' -- estados finales de SendStatus
--                         (packages/mail/src/service/send-store.ts).
-- `PgSendRecordStore.get()` (apps/api) NUNCA devuelve una fila 'pending'
-- como SendRecord (SendStatus no incluye 'pending') -- ver docstring de la
-- clase para el porqué de esa distinción entre "hay una fila" y "hay un
-- resultado final".
--
-- Recuperación de reserva abandonada (equivalente al `not_configured` +
-- `release()` del README): en vez de borrar la fila 'pending' al liberar
-- (lo que perdería la visibilidad "outbox en pending" que pide el
-- requisito), `release()` retrocede `updated_at` para que `reserve()`
-- pueda reclamarla de inmediato en un reintento posterior (no concurrente)
-- con la misma `messageKey` -- mismo criterio de "lease" que
-- `apps/worker/src/queue/job-queue.ts` ya usa sobre `jobs.locked_at`, solo
-- que aquí la ventana de staleness (60s) es la que decide si una reserva
-- pending sigue "viva" o ya se puede reclamar de nuevo.
--
-- No tiene `org_id`/`user_id` NOT NULL a propósito: un correo de
-- verificación o de restablecimiento de contraseña se manda ANTES de que
-- exista sesión (contexto anónimo, igual que oauth_states/refresh_tokens,
-- 0017/0071) -- por eso este outbox es una tabla de sistema, no una tabla
-- por organización: RLS habilitada SIN políticas, todo acceso pasa por las
-- funciones SECURITY DEFINER de abajo (mismo patrón que refresh_tokens).

do $$
begin
  if not exists (select 1 from pg_type where typname = 'mail_outbox_status') then
    create type mail_outbox_status as enum ('pending', 'sent', 'failed_permanent', 'dead');
  end if;
end
$$;

create table if not exists mail_outbox (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  template_id text not null,
  org_id uuid references organizations (id) on delete set null,
  user_id uuid references users (id) on delete set null,
  to_email text,
  status mail_outbox_status not null default 'pending',
  provider_message_id text,
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_mail_outbox_status on mail_outbox (status, updated_at);
create index if not exists ix_mail_outbox_org on mail_outbox (org_id);
create index if not exists ix_mail_outbox_user on mail_outbox (user_id);

alter table mail_outbox enable row level security;

-- reserve(): true (fila devuelta) si esta llamada ganó la reserva -- ver
-- docstring de arriba. `p_max_attempts` se guarda desde ya para que
-- save()/el job de reintento (jobs.kind = 'mail_retry', ver
-- apps/api/src/lib/mail/send-transactional.ts) no dependa de un segundo
-- parámetro fuera de banda.
create or replace function app.mail_outbox_reserve(
  p_dedupe_key text, p_template_id text, p_max_attempts integer, p_org_id uuid, p_user_id uuid, p_to_email text
)
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into mail_outbox (dedupe_key, template_id, status, attempts, max_attempts, org_id, user_id, to_email, created_at, updated_at)
  values (p_dedupe_key, p_template_id, 'pending', 0, p_max_attempts, p_org_id, p_user_id, p_to_email, now(), now())
  on conflict (dedupe_key) do update
    set updated_at = now()
    where mail_outbox.status = 'pending' and mail_outbox.updated_at < now() - interval '60 seconds'
  returning id
$$;

-- get(): SOLO estados finales (nunca 'pending') -- ver docstring de arriba.
create or replace function app.mail_outbox_get(p_dedupe_key text)
returns table (
  dedupe_key text, template_id text, status text, provider_message_id text,
  attempts integer, max_attempts integer, last_error text, updated_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select dedupe_key, template_id, status::text, provider_message_id, attempts, max_attempts, last_error, updated_at
  from mail_outbox
  where dedupe_key = p_dedupe_key and status <> 'pending'
  limit 1
$$;

create or replace function app.mail_outbox_save(
  p_dedupe_key text, p_status text, p_provider_message_id text, p_attempts integer, p_max_attempts integer, p_last_error text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('sent', 'failed_permanent', 'dead') then
    raise exception 'mail_outbox_save_estado_no_permitido: %', p_status;
  end if;
  update mail_outbox
    set status = p_status::mail_outbox_status,
        provider_message_id = p_provider_message_id,
        attempts = p_attempts,
        max_attempts = p_max_attempts,
        last_error = p_last_error,
        updated_at = now()
    where dedupe_key = p_dedupe_key;
end;
$$;

-- release(): retrocede `updated_at` para que una llamada POSTERIOR con la
-- misma llave pueda reclamar la reserva de inmediato (ver docstring de
-- arriba) -- no borra la fila: sigue siendo 'pending' e inspeccionable.
create or replace function app.mail_outbox_release(p_dedupe_key text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update mail_outbox
    set updated_at = now() - interval '61 seconds'
    where dedupe_key = p_dedupe_key and status = 'pending'
$$;

-- Consulta directa de solo-lectura para diagnóstico/pruebas (p.ej. "outbox
-- en pending" cuando no hay proveedor configurado) -- SIN filtrar por
-- estado, a diferencia de mail_outbox_get(). Restringida a superadmin.
create or replace function app.mail_outbox_peek(p_dedupe_key text)
returns table (dedupe_key text, template_id text, status text, attempts integer, max_attempts integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not app.is_superadmin() then
    raise exception 'mail_outbox_peek_requiere_superadmin';
  end if;
  return query
    select m.dedupe_key, m.template_id, m.status::text, m.attempts, m.max_attempts
    from mail_outbox m
    where m.dedupe_key = p_dedupe_key;
end;
$$;

revoke execute on function app.mail_outbox_reserve(text, text, integer, uuid, uuid, text) from public;
grant execute on function app.mail_outbox_reserve(text, text, integer, uuid, uuid, text) to app_role;
revoke execute on function app.mail_outbox_get(text) from public;
grant execute on function app.mail_outbox_get(text) to app_role;
revoke execute on function app.mail_outbox_save(text, text, text, integer, integer, text) from public;
grant execute on function app.mail_outbox_save(text, text, text, integer, integer, text) to app_role;
revoke execute on function app.mail_outbox_release(text) from public;
grant execute on function app.mail_outbox_release(text) to app_role;
revoke execute on function app.mail_outbox_peek(text) from public;
grant execute on function app.mail_outbox_peek(text) to app_role;
