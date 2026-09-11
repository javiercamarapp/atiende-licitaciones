-- 0105_req090_whatsapp_interactive_webhook.sql
-- REQ-090 (WhatsApp como interfaz de trabajo primaria, decide vía
-- botones/listas) + REQ-074 (webhooks de WhatsApp idempotentes por wamid).
--
-- whatsapp_webhook_events_seen: tabla de deduplicación PERMANENTE por
-- `wamid` (id de mensaje de Meta) -- a diferencia de
-- `mail_webhook_events_seen` (0081, con `expires_at` y ventana de
-- tolerancia de Svix), un `wamid` es un identificador GLOBAL y PERMANENTE
-- de Meta que nunca se reutiliza: "ya lo vi" nunca expira, así que no hace
-- falta ninguna columna de expiración ni purga -- ver
-- `packages/whatsapp/src/webhook/replay-guard.ts` para el porqué exacto.
--
-- Tabla de sistema (no por organización: el mismo webhook de Meta procesa
-- interacciones de cualquier organización, la resolución de a qué
-- organización pertenece cada `wamid` ocurre DESPUÉS, en `apps/api`, a
-- partir del contenido del mensaje) -- mismo patrón que `mail_suppressions`/
-- `mail_webhook_events_seen`: RLS habilitada SIN políticas, todo acceso vía
-- la función SECURITY DEFINER de abajo.
create table if not exists whatsapp_webhook_events_seen (
  wamid text primary key,
  received_at timestamptz not null default now()
);

alter table whatsapp_webhook_events_seen enable row level security;

-- claim(): compare-and-set atómico -- `true` la PRIMERA vez que se ve este
-- `wamid` (procesar la interacción), `false` si ya existía (entrega
-- duplicada del mismo mensaje -- Meta reintenta si el webhook no responde
-- 200 a tiempo -- que debe tratarse como no-op).
create or replace function app.whatsapp_webhook_claim(p_wamid text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  insert into whatsapp_webhook_events_seen (wamid) values (p_wamid)
  on conflict (wamid) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke execute on function app.whatsapp_webhook_claim(text) from public;
grant execute on function app.whatsapp_webhook_claim(text) to app_role;
