-- 0099_req070_orchestrator_grants.sql
-- REQ-070 (Orquestador determinista por código sobre colas:
-- Radar→Analista→Redactor→Auditor→Mensajero, docs/REQUISITOS.md).
--
-- El nuevo nodo "Auditor" (`auditor_expediente`, apps/worker/src/agents/
-- named-agents.ts) necesita LEER `proposal_sections` (contenido/`sources`
-- de cada sección ya redactada, packages/db/migrations/0002 o equivalente
-- de creación de esa tabla -- ver schema.sql) para poder calcular un
-- `AuditReport{blocking[],warnings[]}` real (nunca fabricado) desde datos
-- persistidos. `0098_e6_agent_business_tools_grants.sql` ya concedió SELECT
-- + política RLS de `worker_role` sobre `proposals` (para columnas de
-- invalidación) pero NO sobre `proposal_sections` -- esa tabla se quedó
-- fuera de esa lista porque ninguna herramienta de negocio de la Ronda 6 la
-- necesitaba todavía. `apps/worker/src/agents/db-context.ts`
-- (`withWorkerBusinessReadContext`) verifica en el catálogo real de
-- Postgres (`pg_policies`) que exista `sel_proposal_sections_worker_role`
-- ANTES de dejar correr cualquier consulta contra esa tabla -- sin esta
-- migración, `auditar_expediente` fallaría explícito con
-- `SchemaGrantPendingError` (fail-closed, nunca una lista vacía fabricada).
--
-- Mismo patrón exacto que 0098 (grant de tabla completa + política
-- PERMISSIVE adicional que se combina con OR con `app.apply_org_rls`,
-- reconociendo a `worker_role` por identidad real de conexión).
--
-- Número: siguiente libre tras 0098_e6_agent_business_tools_grants.sql.

grant select on proposal_sections to worker_role;

drop policy if exists sel_proposal_sections_worker_role on proposal_sections;
create policy sel_proposal_sections_worker_role on proposal_sections
  for select using (current_user = 'worker_role');
