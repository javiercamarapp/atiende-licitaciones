-- 0044_fix_db09_agent_run_context_bootstrap_guard.sql
-- Mitiga (PARCIALMENTE) DB-09 (docs/auditoria-1/db-api-reverificacion.md,
-- BAJA): `app.agent_run_context(p_run_id uuid)` (0025) es SECURITY DEFINER
-- y devuelve `org_id`/`actor_id` de CUALQUIER `agent_run` dado su UUID, sin
-- validar que el llamador tenga relación alguna con esa corrida ni con su
-- organización -- rompe la misma invariante que DB-01/DB-08, aunque con
-- impacto acotado (agent_runs.id es un UUID no adivinable, y solo expone
-- dos ids, nunca el contenido de la corrida).
--
-- Mitigación aplicada aquí (mismo patrón "pre-sesión" que 0019 usó para
-- `app.find_user_by_email`): la función ahora rechaza ejecutarse si
-- `app.current_user_id()` YA está fijado -- es decir, solo es utilizable en
-- el contexto "sin sesión todavía" para el que fue diseñada (resolver a
-- qué organización pertenece una corrida ANTES de poder fijar
-- `app.current_org_id()`/`app.current_user_id()` y dejar que RLS opere).
--
-- GAP RESIDUAL DOCUMENTADO (no se cierra en esta migración): a diferencia
-- de `find_user_by_email` (donde "sin contexto" coincide exactamente con
-- "todavía no autenticado, a punto de validar una contraseña"), aquí
-- "sin contexto" NO implica ninguna autenticación real -- un atacante
-- puede simplemente abrir una transacción nueva sin fijar contexto (el
-- mismo patrón que usa el llamador legítimo) y seguir explotando el hueco
-- con cualquier UUID adivinado. El cierre completo de DB-09 requiere que
-- `apps/api/src/lib/agent-stores.pg.ts` (RunStore/ToolCallStore Postgres,
-- packages/agents) pase la identidad YA autenticada del actor como
-- parámetro adicional para que la función pueda validar membresía real --
-- ese archivo está fuera del ámbito de este agente (no pertenece a
-- apps/api/src/modules/auth/** ni apps/api/src/modules/organizations/**,
-- los únicos módulos de apps/api en su ámbito). Queda documentado como
-- pendiente real, no oculto, siguiendo el mismo criterio de honestidad que
-- ya usa este proyecto para DB-07 (packages/db/README.md).

create or replace function app.agent_run_context(p_run_id uuid)
returns table (org_id uuid, actor_id uuid)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_user_id() is not null then
    raise exception 'agent_run_context_not_allowed_in_session_context';
  end if;

  return query
    select ar.org_id, ar.actor_id from agent_runs ar where ar.id = p_run_id;
end;
$$;

revoke execute on function app.agent_run_context(uuid) from public;
grant execute on function app.agent_run_context(uuid) to app_role;
