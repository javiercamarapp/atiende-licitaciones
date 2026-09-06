-- PROPOSAL-06-agent-business-tools-grants.sql
-- PENDIENTE esquema (Ronda 6, agentes de negocio reales en apps/worker).
--
-- Propuesta de apps/worker para quien mantiene packages/db. Fuera de mi
-- ámbito: NO se aplicó, NO se añadió a packages/db/migrations/. El número
-- final de archivo real lo asigna quien la incorpore, coordinado con
-- cualquier migración concurrente. Sigue el MISMO patrón ya incorporado en
-- `packages/db/migrations/0028_worker_role.sql` (WK-08/WK-23): grants
-- mínimos y explícitos sobre `worker_role`, más políticas RLS ADICIONALES
-- (nunca reemplazan las existentes — PostgreSQL combina políticas
-- PERMISSIVE del mismo comando con OR) que reconocen a `worker_role` por
-- IDENTIDAD REAL de conexión (`current_user = 'worker_role'`), apropiado
-- para un proceso de servicio que actúa autónomamente sobre eventos de
-- plataforma (nueva convocatoria ingerida, nueva versión/cambio de bases,
-- vencimiento próximo), no "como" un usuario humano autenticado con
-- membresía real en cada organización afectada.
--
-- Motivación (docs/investigacion/paridad-producto.md Ronda K,
-- docs/AMPLIACION-BACKOFFICE.md §3-9): los agentes nombrados de
-- `apps/worker/src/agents/business-tools.ts` (`listar_convocatorias`,
-- `leer_bases`, `leer_perfil_empresa`, `resumir_cambios_convocatoria`)
-- necesitan LEER `tenders`/`tender_documents`/`tender_versions`/
-- `tender_change_events`/`requirement_items`/`company_profiles`/
-- `capabilities`/`experience_records`/`compliance_items`/`proposals`
-- (esta última solo para leer `invalidated_at`/`invalidated_reason`, nunca
-- su contenido de propuesta). `0028_worker_role.sql` dejó EXPLÍCITAMENTE
-- sin grants estas tablas ("si apps/worker necesita tocar otra tabla en el
-- futuro, ese grant debe añadirse aquí de forma explícita y revisada,
-- nunca heredado implícitamente de un rol propietario") — esta propuesta es
-- exactamente esa adición explícita y revisada.
--
-- Además, `agent_runs` necesita un grant de INSERT (hoy solo
-- select/update, ver 0028) para el caso en que sea el PROPIO worker quien
-- detecta un evento de plataforma (ingesta de una convocatoria nueva,
-- versión/cambio de bases, vencimiento próximo) y decide correr un agente
-- nombrado de forma autónoma, SIN que `apps/api` haya creado previamente
-- la fila `agent_runs` (a diferencia del caso ya cubierto por 0028: una
-- corrida solicitada por un usuario humano vía `apps/api`, que sí crea la
-- fila antes de encolar el job). Sin este grant, una corrida disparada por
-- evento no tiene ninguna fila que actualizar al terminar y su resultado
-- solo queda en el log del proceso (ver
-- `apps/worker/src/agents/enqueue-agent-run.ts`, documentado como
-- limitación mientras esta migración no se aplique).
--
-- Hasta que esta propuesta se incorpore a packages/db, CUALQUIER intento
-- real de estas herramientas contra un Postgres de producción real falla
-- con un error de permisos EXPLÍCITO de Postgres (nunca una lista vacía
-- fabricada ni un "no hay datos" silencioso) — ver
-- `apps/worker/src/agents/db-context.ts` (`SchemaGrantPendingError`), que
-- traduce ese fallo a un mensaje claro y lo marca `permanent: true` (WK-10:
-- reintentar no lo arregla, hace falta que esta migración se aplique).
-- Las pruebas de `apps/worker/test/` (que sí necesitan que este código
-- funcione para poder probarlo) aplican este archivo directamente sobre una
-- base ya migrada con las migraciones REALES de `packages/db`, sin tocar
-- `packages/db/migrations/` — mismo patrón ya usado por
-- `PROPOSAL-01`/`PROPOSAL-02`/`PROPOSAL-03` de esta misma carpeta.

-- Lectura de negocio: exactamente las tablas que las herramientas de
-- solo-lectura necesitan, ni una más. Ninguna tabla de escritura sensible
-- (proposals.content, company_documents con datos personales, pricing,
-- approvals) se concede aquí salvo lectura de columnas de invalidación de
-- `proposals` (el SELECT es a nivel de tabla en Postgres, no de columna;
-- las herramientas de este worker SOLO proyectan `invalidated_at`/
-- `invalidated_reason`/`id`/`tender_id` de esa tabla en su SQL, nunca
-- `content`, pero un grant de columna sería más preciso — ver "Alcance más
-- fino" al final de este archivo).
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

-- Alcance más fino (mejora futura, no bloqueante para esta propuesta): un
-- `grant select (id, org_id, tender_id, invalidated_at, invalidated_reason)
-- on proposals to worker_role` (grant de columna, PostgreSQL lo soporta)
-- sería más preciso que el `grant select on proposals` de arriba, que
-- técnicamente permite a `worker_role` leer `proposals.content` si algún
-- código futuro de este worker lo consultara por error. Se deja como grant
-- de tabla completa por simplicidad de esta primera propuesta; el código de
-- `apps/worker` (revisable) es hoy la única barrera que impide proyectar
-- esa columna. Quien incorpore esta propuesta puede endurecerlo a grant de
-- columna sin cambiar el contrato de las herramientas.
