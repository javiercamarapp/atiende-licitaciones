-- 0100_req092_voice_agent_config.sql
-- REQ-092/REQ-093 (docs/REQUISITOS.md §21 "Móvil / Canales"): configuración
-- por organización del agente de voz/Realtime (ElevenLabs Conversational
-- AI) -- mismo patrón de tabla ya usado en el repo hermano atiende-hoteles
-- (`hotel_voice_agent_config`, packages/db/migrations/0126 de ese repo),
-- adaptado al modelo de tenant de ESTE repo (`organizations`/`memberships`,
-- roles `org_role`) en vez del suyo (`hotels`).
--
-- Número: 0099 (siguiente libre tras 0098_e6_agent_business_tools_grants.sql
-- en `main` al momento de crear esta rama) ya lo reclaman EN PARALELO al
-- menos otras 3 ramas `closure/*` en vuelo sobre este mismo repo (cada una
-- con su propio REQ, verificado por inspección directa de los worktrees
-- hermanos en `/tmp/wf-lic-*` al momento de escribir esta migración) -- se
-- usa 0100 para reducir la colisión de renumeración en el merge, aunque no
-- puede garantizarse contra ramas no visibles en ese momento. Quien haga el
-- merge/rebase final debe renumerar la que llegue después si el número ya
-- fue tomado por otra rama ya integrada.
--
-- Diseño:
--   - Un secreto POR ORGANIZACIÓN (`tool_webhook_secret`), no uno global
--     compartido -- el aislamiento por tenant es un eje de seguridad central
--     de este repo (RLS por org_id en cada tabla de negocio). Una
--     organización nunca puede, ni por bug de configuración, invocar las
--     tools de voz de otra.
--   - `enabled` por defecto `false`: crear la fila (al abrir por primera vez
--     la pantalla de configuración, ver `apps/api/src/modules/voice/routes.ts`
--     `ensureVoiceAgentConfig`) nunca activa el canal de voz por sí solo.
--   - RLS restringida a `owner`/`admin` tanto para lectura como escritura
--     (a diferencia del patrón general de `company_profiles`, que permite
--     lectura más amplia): el secreto de este webhook es lo único que
--     autentica una llamada real de ElevenLabs contra este backend -- quien
--     lo lee puede impersonar al agente de voz de esa organización.
create table if not exists voice_agent_config (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references organizations (id) on delete cascade,
  elevenlabs_agent_id text,
  tool_webhook_secret text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_voice_agent_config_updated_at on voice_agent_config;
create trigger trg_voice_agent_config_updated_at
  before update on voice_agent_config
  for each row execute function app.set_updated_at();

do $$
declare
  membership_admin_roles org_role[] := '{owner,admin}';
begin
  perform app.apply_org_rls('voice_agent_config', membership_admin_roles, membership_admin_roles);
end;
$$;

comment on table voice_agent_config is
  'REQ-092/REQ-093: configuración por organización del agente de voz/Realtime (ElevenLabs '
  'Conversational AI) -- POST /webhooks/voz/:orgId/:toolName (apps/api) verifica '
  'tool_webhook_secret directamente vía la conexión que evade RLS (mismo patrón aceptado que '
  'POST /internal/tenders/ingest y POST /webhooks/mail/:provider, ver esos comentarios), nunca '
  'con SET LOCAL ROLE app_role -- ElevenLabs no es un miembro humano de la organización.';
