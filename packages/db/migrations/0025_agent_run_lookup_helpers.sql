-- 0025_agent_run_lookup_helpers.sql
-- `RunStore.getRun(runId)`/`updateRun(runId, patch)` (packages/agents) solo
-- reciben el id de la corrida, no la organización -- a diferencia de las
-- rutas HTTP normales de apps/api, que siempre resuelven el tenant desde
-- X-Org-Id ANTES de tocar la base. El adaptador Postgres
-- (apps/api/src/lib/agent-stores.pg.ts) necesita saber a qué organización
-- pertenece una corrida para poder fijar `app.current_org_id` y que RLS
-- funcione -- el mismo problema de "huevo y gallina" que login/
-- resolución de X-Org-Id (ver 0010/0019), resuelto con el mismo patrón:
-- una función SECURITY DEFINER de alcance mínimo (devuelve solo el
-- `org_id`/`actor_id`, nunca el contenido de la corrida) invocable sin
-- contexto de sesión previo.
create or replace function app.agent_run_context(p_run_id uuid)
returns table (org_id uuid, actor_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select org_id, actor_id from agent_runs where id = p_run_id
$$;
