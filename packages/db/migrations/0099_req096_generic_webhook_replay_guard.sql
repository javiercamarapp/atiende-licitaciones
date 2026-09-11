-- 0099_req096_generic_webhook_replay_guard.sql
-- REQ-096: generaliza el anti-replay de webhooks (ML-05, hasta ahora solo
-- para el webhook de correo -- `mail_webhook_events_seen`/
-- `app.mail_webhook_claim`, 0081) a una tabla/función ÚNICA reutilizable por
-- CUALQUIER webhook entrante NUEVO, sin que cada proveedor tenga que crear
-- su propia tabla `<algo>_webhook_events_seen` + función `app.<algo>_claim`
-- desde cero. Implementa `WebhookReplayGuard` de `@atiende/webhooks`
-- (packages/webhooks/src/replay-guard.ts) -- ver
-- `apps/api/src/lib/webhooks/pg-webhook-replay-guard.ts`.
--
-- NO reemplaza ni migra `mail_webhook_events_seen`/`app.mail_webhook_claim`:
-- esa tabla sigue en producción, ya probada (packages/db/test/req181-mail.test.ts,
-- apps/api/test/mail-webhook.test.ts) y consumida por
-- `apps/api/src/lib/mail/pg-webhook-replay-guard.ts` -- tocarla no aporta
-- nada (el dato es efímero, con TTL de minutos) y sí arriesga el webhook de
-- correo que ya funciona en producción. Esta tabla es para el SIGUIENTE
-- webhook, namespaced por `provider` para que dos proveedores distintos
-- nunca colisionen si por coincidencia usan el mismo event_id.
create table if not exists webhook_events_seen (
  provider text not null,
  event_id text not null,
  expires_at timestamptz not null,
  primary key (provider, event_id)
);

create index if not exists ix_webhook_events_seen_expires on webhook_events_seen (expires_at);

alter table webhook_events_seen enable row level security;

-- claim(): compare-and-set atómico -- `true` la PRIMERA vez que se ve este
-- (provider, event_id) (INSERT gana), `false` si ya existe y no ha
-- expirado (replay real dentro de la ventana de tolerancia). Una fila ya
-- expirada se borra primero para permitir reinsertarla si el proveedor
-- llegara a reutilizar un event_id tras la ventana de tolerancia (mismo
-- criterio que app.mail_webhook_claim, 0081).
create or replace function app.webhook_claim(p_provider text, p_event_id text, p_tolerance_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  delete from webhook_events_seen
   where provider = p_provider and event_id = p_event_id and expires_at < now();

  insert into webhook_events_seen (provider, event_id, expires_at)
  values (p_provider, p_event_id, now() + make_interval(secs => greatest(p_tolerance_seconds, 0)))
  on conflict (provider, event_id) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function app.webhook_claim(text, text, integer) from public;
grant execute on function app.webhook_claim(text, text, integer) to app_role;
