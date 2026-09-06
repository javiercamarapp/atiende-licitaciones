-- PROPOSAL-03-worker-role.sql
-- PENDIENTE esquema (WK-08, docs/auditoria-1/worker.md).
--
-- Propuesta de apps/worker para quien mantiene packages/db. Fuera de mi
-- ámbito: NO se aplicó, NO se añadió a packages/db/migrations/. El número
-- final de archivo real lo asigna quien la incorpore, coordinado con
-- cualquier migración concurrente.
--
-- Problema (WK-08): apps/worker se conecta con `createDbClientFromEnv`
-- (packages/db/src/driver.ts), la MISMA conexión "propietaria"/superusuario
-- de las migraciones. `packages/db/migrations/0007_rls_functions.sql`
-- documenta que ese rol NO tiene `FORCE ROW LEVEL SECURITY` aplicada, así
-- que el alcance real de acceso es TODO el esquema (todos los tenants,
-- todas las tablas), no solo `jobs`/`source_runs`/`agent_runs` como sugiere
-- hoy la sección "Seguridad" del README de apps/worker (corregido en esta
-- ronda para dejar de subestimarlo).
--
-- Mitigación YA aplicada en este mismo ámbito (apps/worker), sin tocar
-- packages/db: `updateAgentRunRow` (apps/worker/src/handlers/run-agent.ts)
-- ahora filtra explícitamente `WHERE id = $1 AND org_id = $2` (defensa en
-- profundidad) y fija `app.current_org_id` vía `set_config` antes del
-- UPDATE, dejando el contexto listo para cuando este `worker_role` exista.
-- Esa mitigación reduce el riesgo de "sobrescribir en silencio la corrida de
-- otro tenant por payload corrupto", pero NO limita el acceso de la
-- conexión en sí: con el rol propietario, cualquier bug futuro en cualquier
-- query de apps/worker puede tocar cualquier tabla de cualquier org sin que
-- RLS lo impida. La solución estructural es este `worker_role` dedicado.
--
-- Grants mínimos: exactamente lo que apps/worker necesita hoy (jobs,
-- source_runs, agent_runs), ni más ni menos. `agent_runs` queda con RLS
-- real activada vía `app_role`/`app.current_org_id` (mismo patrón que
-- packages/db/src/context.ts `withTenantContext`) para que un
-- `worker_role` que corra como `app_role` con el org_id correcto fijado
-- SÍ quede bloqueado por RLS si intenta tocar la fila de otro tenant —
-- complementa (no reemplaza) la verificación explícita `org_id = $2` ya
-- añadida en el código.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'worker_role') then
    create role worker_role login password 'CAMBIAR_EN_DESPLIEGUE_REAL' inherit;
  end if;
end
$$;

-- worker_role hereda las políticas RLS de app_role para agent_runs (y
-- cualquier otra tabla con RLS existente), en vez de ser un rol
-- "propietario" que las salta.
grant app_role to worker_role;

-- jobs: el worker necesita ver/tomar jobs de TODAS las organizaciones (no
-- hay aislamiento por tenant real en esta tabla, ver README §Seguridad) y
-- escribir su propio ciclo de vida (status/attempts/locked_*/last_error).
grant select, insert, update on jobs to worker_role;

-- source_runs: tabla de plataforma (sin org_id), "solo back office" —
-- apps/worker necesita poder insertar/leer para hacer su trabajo (registrar
-- cada corrida) igual que hoy, sin necesitar privilegios de propietario del
-- resto del esquema.
grant select, insert on source_runs to worker_role;

-- agent_runs: el worker solo necesita actualizar el resultado FINAL de una
-- corrida ya creada por apps/api (no crea filas nuevas) y leerla para
-- verificar org_id (defensa en profundidad ya en el código).
grant select, update on agent_runs to worker_role;

-- Explícitamente SIN grants sobre cualquier otra tabla del esquema
-- (tenders, proposals, documents, etc.): si algún día apps/worker necesita
-- tocar otra tabla, ese grant debe añadirse aquí de forma explícita y
-- revisada, nunca heredado implícitamente de un rol propietario.

-- Migración de `apps/worker` (fuera de este archivo, en código, una vez
-- este rol exista): cambiar `createDbClientFromEnv` por una conexión que
-- use `worker_role` (nueva variable de entorno, p. ej.
-- `WORKER_DATABASE_URL` con ese usuario) en vez de `DATABASE_URL` genérica,
-- y envolver los UPDATE/SELECT sobre `agent_runs` en
-- `withTenantContext`/`applyTenantContext` (packages/db/src/context.ts) con
-- el `orgId` del job, para que RLS real aplique.
