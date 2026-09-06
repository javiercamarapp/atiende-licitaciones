-- 0081_req181_mail_suppression_and_webhook_replay.sql
-- REQ-181..195: implementaciones persistentes de `SuppressionStore`
-- (packages/mail/src/suppression/types.ts) y `WebhookReplayGuard`
-- (packages/mail/src/webhooks/replay-guard.ts) sobre Postgres --
-- `apps/api/src/lib/mail/pg-suppression-store.ts` y
-- `apps/api/src/lib/mail/pg-webhook-replay-guard.ts` las consumen.
--
-- mail_suppressions: DENY-ALL/FAIL-CLOSED (ver README de packages/mail) --
-- una dirección aquí no vuelve a recibir correo hasta que alguien la quite
-- a mano (`unsuppress`). Tabla de sistema (no por organización: una
-- dirección de correo puede pertenecer a más de una organización) -- RLS
-- habilitada SIN políticas, todo acceso vía funciones SECURITY DEFINER.
create table if not exists mail_suppressions (
  email text primary key,
  reason text not null,
  source text not null,
  created_at timestamptz not null default now()
);

alter table mail_suppressions enable row level security;

create or replace function app.mail_suppression_check(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from mail_suppressions where email = lower(trim(p_email)))
$$;

create or replace function app.mail_suppression_add(p_email text, p_reason text, p_source text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into mail_suppressions (email, reason, source, created_at)
  values (lower(trim(p_email)), p_reason, p_source, now())
  on conflict (email) do update set reason = excluded.reason, source = excluded.source, created_at = now()
$$;

create or replace function app.mail_suppression_remove(p_email text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from mail_suppressions where email = lower(trim(p_email))
$$;

create or replace function app.mail_suppression_get(p_email text)
returns table (email text, reason text, source text, created_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select email, reason, source, created_at from mail_suppressions where email = lower(trim(p_email))
$$;

revoke execute on function app.mail_suppression_check(text) from public;
grant execute on function app.mail_suppression_check(text) to app_role;
revoke execute on function app.mail_suppression_add(text, text, text) from public;
grant execute on function app.mail_suppression_add(text, text, text) to app_role;
revoke execute on function app.mail_suppression_remove(text) from public;
grant execute on function app.mail_suppression_remove(text) to app_role;
revoke execute on function app.mail_suppression_get(text) from public;
grant execute on function app.mail_suppression_get(text) to app_role;

-- ---------------------------------------------------------------------------
-- Anti-replay de webhooks de correo (ML-05, ver packages/mail README §Cabeceras
-- List-Unsubscribe / Anti-replay): `mail_webhook_events_seen` es la tabla
-- "de vida corta" que el README de packages/mail describe como ejemplo --
-- `svix_id` PRIMARY KEY, `expires_at` para poder purgar. `apps/api` expone
-- `POST /webhooks/mail/:provider` usando
-- `verifyResendWebhookSignatureWithReplayGuard()` con un
-- `WebhookReplayGuard` implementado sobre esta tabla.
create table if not exists mail_webhook_events_seen (
  svix_id text primary key,
  expires_at timestamptz not null
);

create index if not exists ix_mail_webhook_events_seen_expires on mail_webhook_events_seen (expires_at);

alter table mail_webhook_events_seen enable row level security;

-- claim(): compare-and-set atómico -- `true` la PRIMERA vez que se ve este
-- `svix_id` (INSERT gana), `false` si ya existe y no ha expirado (replay
-- real dentro de la ventana de tolerancia). Un `svix_id` ya expirado se
-- borra primero para permitir reinsertarlo si por alguna razón se
-- reutilizara (no debería pasar con IDs generados por Svix, pero evita que
-- esta tabla crezca sin límite).
create or replace function app.mail_webhook_claim(p_svix_id text, p_tolerance_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  delete from mail_webhook_events_seen where svix_id = p_svix_id and expires_at < now();

  insert into mail_webhook_events_seen (svix_id, expires_at)
  values (p_svix_id, now() + make_interval(secs => greatest(p_tolerance_seconds, 0)))
  on conflict (svix_id) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function app.mail_webhook_claim(text, integer) from public;
grant execute on function app.mail_webhook_claim(text, integer) to app_role;
