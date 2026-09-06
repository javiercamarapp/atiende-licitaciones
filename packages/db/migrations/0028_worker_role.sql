-- 0028_worker_role.sql
-- Incorpora PROPOSAL-03-worker-role.sql (apps/worker/db-proposals/, WK-08,
-- docs/auditoria-1/worker.md), con dos correcciones deliberadas respecto a
-- la propuesta original (documentadas abajo) hechas por quien mantiene
-- packages/db al incorporarla.
--
-- Problema (WK-08): apps/worker se conecta hoy con la conexión
-- "propietaria"/superusuario de las migraciones (`createDbClientFromEnv`),
-- que NO tiene `FORCE ROW LEVEL SECURITY` (0007) y por tanto tiene acceso
-- real a TODO el esquema, no solo a jobs/source_runs/agent_runs. Este rol
-- dedicado, con grants mínimos y sujeto a RLS real, es la solución
-- estructural.
--
-- CORRECCIÓN 1 (seguridad, REQ-095 "nunca contraseñas en código"): la
-- propuesta original creaba el rol con `login password
-- 'CAMBIAR_EN_DESPLIEGUE_REAL'` -- un placeholder de contraseña committeado
-- en una migración versionada es exactamente el patrón que REQ-095 prohíbe
-- (un placeholder olvidado es una contraseña real débil en producción). El
-- rol se crea aquí `nologin` desde la migración; habilitar el login con una
-- contraseña real es una acción de despliegue/ops SEPARADA
-- (`alter role worker_role login password '<secreto real, nunca en git>'`),
-- fuera de esta migración y fuera de control de versiones.
--
-- CORRECCIÓN 2 (funcional): la propuesta original solo otorgaba `grant
-- app_role to worker_role` + grants de tabla, asumiendo que la RLS
-- existente de `jobs`/`source_runs` ya cubría el caso de uso del worker.
-- Verificado que NO es así:
--   - `jobs.org_id` es NULLABLE (0003_system_tables.sql) y muchos jobs de
--     descubrimiento son de PLATAFORMA (sin organización). La política
--     genérica de `app.apply_org_rls` exige `org_id = app.current_org_id()`
--     (falso para NULL) Y `app.has_role(...)` (que requiere una membresía
--     real de `app.current_user_id()`, un concepto que el worker -- un
--     proceso de sistema, no una sesión de usuario -- no tiene). Sin una
--     política adicional, worker_role JAMÁS vería ni un solo job.
--   - `source_runs` (0013) exige `app.is_superadmin()` para SELECT/INSERT,
--     que también depende de `app.current_user_id()`. worker_role nunca
--     sería superadmin bajo ese esquema.
-- Se añaden políticas ADICIONALES (con OR sobre las existentes, nunca
-- reemplazándolas) que reconocen al rol de Postgres `worker_role` POR
-- IDENTIDAD REAL de conexión (`current_user = 'worker_role'`), no por GUC
-- de sesión -- apropiado para una cuenta de servicio que no actúa "como"
-- un usuario humano autenticado. `agent_runs` NO necesita política nueva:
-- ese caso de uso (actualizar el resultado de una corrida ya creada por
-- apps/api para una organización conocida) si se combina con
-- `set_config('app.current_user_id', <actor_id de la corrida>, true)`
-- (que apps/worker ya puede resolver, pues conoce `agent_runs.actor_id`)
-- sí satisface la política de organización existente sin cambios.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'worker_role') then
    create role worker_role nologin inherit;
  end if;
end
$$;

-- worker_role hereda los grants de app_role (incl. los privilegios de
-- tabla por defecto de 0001) y queda sujeto a las mismas políticas RLS
-- (nunca las salta, a diferencia del rol propietario de las migraciones).
grant app_role to worker_role;

-- jobs: el worker necesita ver/tomar/actualizar jobs de TODAS las
-- organizaciones (incluidos los de plataforma, org_id NULL).
grant select, insert, update on jobs to worker_role;

-- source_runs: tabla de plataforma (sin org_id); el worker registra cada
-- corrida de ingesta.
grant select, insert on source_runs to worker_role;

-- agent_runs: el worker solo actualiza el resultado final de una corrida ya
-- creada por apps/api (nunca crea filas nuevas).
grant select, update on agent_runs to worker_role;

-- Explícitamente SIN grants sobre ninguna otra tabla del esquema (tenders,
-- proposals, company_documents, etc.): si apps/worker necesita tocar otra
-- tabla en el futuro, ese grant debe añadirse aquí de forma explícita y
-- revisada, nunca heredado implícitamente de un rol propietario.

drop policy if exists sel_jobs on jobs;
create policy sel_jobs on jobs
  for select using (
    current_user = 'worker_role'
    or app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists ins_jobs on jobs;
create policy ins_jobs on jobs
  for insert with check (
    current_user = 'worker_role'
    or app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists upd_jobs on jobs;
create policy upd_jobs on jobs
  for update using (
    current_user = 'worker_role'
    or app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  )
  with check (
    current_user = 'worker_role'
    or app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists sel_source_runs on source_runs;
create policy sel_source_runs on source_runs
  for select using (current_user = 'worker_role' or app.is_superadmin());

drop policy if exists ins_source_runs on source_runs;
create policy ins_source_runs on source_runs
  for insert with check (current_user = 'worker_role' or app.is_superadmin());
