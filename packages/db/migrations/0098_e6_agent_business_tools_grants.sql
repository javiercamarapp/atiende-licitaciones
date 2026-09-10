-- 0098_e6_agent_business_tools_grants.sql
-- Incorpora PROPOSAL-06-agent-business-tools-grants.sql (apps/worker/db-proposals/,
-- Ronda 6, docs/BLOQUEOS.md fila "E6-ciclo-agentes"), SIN cambios respecto al
-- SQL propuesto (copiado tal cual) -- mismo patrón ya usado al incorporar
-- PROPOSAL-01/02/03 (ver 0026/0027/0028): la propuesta de apps/worker ya
-- fue revisada y verificada por su propio harness de test
-- (`apps/worker/test/proposal-06-helper.ts` + los tests que lo usaban antes
-- de esta migración), así que se incorpora sin correcciones.
--
-- Motivación completa, tabla por tabla y política por política: ver el
-- archivo original `apps/worker/db-proposals/PROPOSAL-06-agent-business-tools-grants.sql`
-- (se conserva como registro histórico de la propuesta, igual que
-- PROPOSAL-01/02/03 siguen presentes tras 0026/0027/0028). Resumen: las
-- herramientas de negocio de `apps/worker/src/agents/business-tools.ts`
-- (`listar_convocatorias`, `leer_bases`, `leer_perfil_empresa`,
-- `resumir_cambios_convocatoria`) necesitan SELECT sobre
-- tenders/tender_documents/tender_versions/tender_change_events/
-- requirement_items/company_profiles/capabilities/experience_records/
-- compliance_items/proposals (esta última solo para columnas de
-- invalidación, nunca `content`), que `0028_worker_role.sql` dejó
-- explícitamente sin conceder. Además, INSERT sobre `agent_runs` para que
-- el propio worker pueda abrir su fila cuando reacciona de forma autónoma
-- a un evento de plataforma (sin que `apps/api` la haya creado antes), con
-- políticas RLS adicionales acotadas a `started_by is null` para no
-- debilitar la garantía de WK-23 sobre corridas de un humano real.
--
-- Número: siguiente libre tras 0097_rate_limit_buckets.sql, sin colisión
-- verificada contra ninguna otra rama en vuelo a la fecha de esta migración
-- (docs/BLOQUEOS.md, "E6-ciclo-agentes").

grant select on tenders to worker_role;
grant select on tender_documents to worker_role;
grant select on tender_versions to worker_role;
grant select on tender_change_events to worker_role;
grant select on requirement_items to worker_role;
grant select on company_profiles to worker_role;
grant select on capabilities to worker_role;
grant select on experience_records to worker_role;
grant select on compliance_items to worker_role;
grant select on proposals to worker_role;

-- agent_runs: además del select/update ya otorgado por 0028, INSERT para
-- que el propio worker pueda abrir su propia fila cuando reacciona de forma
-- autónoma a un evento de plataforma (ver justificación arriba).
grant insert on agent_runs to worker_role;

-- Políticas RLS ADICIONALES (permisivas, se combinan con OR con las ya
-- existentes de app.apply_org_rls — nunca las reemplazan): reconocen a
-- worker_role por identidad real de conexión, igual que 0028 ya hace para
-- jobs/source_runs.
do $$
declare
  t text;
  read_tables text[] := array[
    'tenders', 'tender_documents', 'tender_versions', 'tender_change_events',
    'requirement_items', 'company_profiles', 'capabilities', 'experience_records',
    'compliance_items', 'proposals'
  ];
begin
  foreach t in array read_tables loop
    execute format('drop policy if exists sel_%s_worker_role on %I', t, t);
    execute format(
      'create policy sel_%s_worker_role on %I for select using (current_user = ''worker_role'')',
      t, t
    );
  end loop;
end
$$;

-- IMPORTANTE (revisado deliberadamente para NO debilitar WK-23,
-- docs/auditoria-1/worker-cierre.md): esta política de INSERT/UPDATE
-- adicional se restringe a filas con `started_by is null` -- es decir,
-- EXCLUSIVAMENTE corridas que el propio worker abrió de forma autónoma por
-- un evento de plataforma (nunca solicitadas por un humano vía apps/api,
-- que SIEMPRE fija `started_by` al usuario real que las pidió). Una
-- política sin esta condición ("cualquier agent_runs con
-- current_user='worker_role'") habría revertido la garantía de WK-23 para
-- TODAS las corridas -- incluidas las de un humano real -- porque
-- PostgreSQL combina políticas PERMISSIVE del mismo comando con OR: bastaría
-- con que `updateAgentRunRow` corriera como worker_role (que siempre lo
-- hace) para que el chequeo de membresía real de `actorId` (RLS existente,
-- 0008) se volviera irrelevante en la práctica. Con `started_by is null`,
-- una fila creada por/para un humano (`started_by` no nulo) sigue
-- protegida EXCLUSIVAMENTE por la política existente (membresía real de
-- `actorId`) -- esta política adicional nunca la alcanza.
drop policy if exists ins_agent_runs_worker_role on agent_runs;
create policy ins_agent_runs_worker_role on agent_runs
  for insert with check (current_user = 'worker_role' and started_by is null);

drop policy if exists upd_agent_runs_worker_role on agent_runs;
create policy upd_agent_runs_worker_role on agent_runs
  for update using (current_user = 'worker_role' and started_by is null)
  with check (current_user = 'worker_role' and started_by is null);

-- SELECT adicional (misma condición `started_by is null`): descubierto
-- probando esto contra PGlite real, no una suposición de diseño --
-- `INSERT ... RETURNING id` (usado por
-- `apps/worker/src/agents/enqueue-agent-run.ts` para obtener el id de la
-- fila recién creada) exige que la fila resultante también sea VISIBLE
-- bajo la política de SELECT vigente, no solo que pase el `WITH CHECK` de
-- INSERT -- sin esta política adicional, `RETURNING` falla con el MISMO
-- error ("new row violates row-level security policy") aunque el INSERT
-- en sí sería válido. Sin esta política, `enqueueAgentRun` simplemente no
-- podría leer el `id` que acaba de crear.
drop policy if exists sel_agent_runs_worker_role on agent_runs;
create policy sel_agent_runs_worker_role on agent_runs
  for select using (current_user = 'worker_role' and started_by is null);

-- Alcance más fino (mejora futura, no bloqueante para esta migración): un
-- `grant select (id, org_id, tender_id, invalidated_at, invalidated_reason)
-- on proposals to worker_role` (grant de columna, PostgreSQL lo soporta)
-- sería más preciso que el `grant select on proposals` de arriba, que
-- técnicamente permite a `worker_role` leer `proposals.content` si algún
-- código futuro de este worker lo consultara por error. Se deja como grant
-- de tabla completa por simplicidad de esta primera incorporación; el
-- código de `apps/worker` (revisable) es hoy la única barrera que impide
-- proyectar esa columna.
