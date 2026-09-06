-- 0088_e20_agent_runs_correlation_id.sql
-- E20 (docs/BACKLOG.md, "Índice de correlation_id en agent_runs (BAJA, tras
-- WK6-02)").
--
-- CORRECCIÓN DE UN MALENTENDIDO DOCUMENTADO: `agent_runs.correlation_id`
-- (con su índice `ix_agent_runs_correlation (org_id, correlation_id)`) YA
-- EXISTE desde `0017_ronda2_extensions.sql` -- `apps/api/src/lib/
-- agent-stores.pg.ts` ya la puebla al CREAR una corrida (`insert into
-- agent_runs (..., correlation_id, ...)`). `apps/worker/README.md`
-- ("WK6-02") documentaba como límite honesto que la consulta de auditoría
-- de REQ-171 iba "contra el JSONB (`output->>'correlationId'`) y no hay
-- índice para ella" -- ese diagnóstico describía bien el síntoma (el
-- worker no podía usar una columna indexada) pero no la causa exacta: la
-- columna SÍ existía, lo que faltaba era que
-- `apps/worker/src/handlers/run-agent.ts` (`updateAgentRunRow`, el UPDATE
-- que cierra una corrida disparada por un job) la escribiera -- antes de
-- esta ronda ese UPDATE solo tocaba `status`/`output`/`finished_at`, nunca
-- `correlation_id`, así que toda corrida cerrada por un JOB (a diferencia
-- de la fila que `agent-stores.pg.ts` crea al INICIO) dejaba la columna en
-- NULL aunque `output->>'correlationId'` sí la tuviera.
--
-- Esta migración NO repite `alter table`/`create index` (ambos siguen
-- `if not exists`, así que son no-op seguro sobre la columna/índice de
-- 0017, documentado aquí por si un futuro lector solo mira 0088 y no
-- 0017), y hace lo único que faltaba a nivel de esquema: BACKFILL de las
-- filas que ya existen con `correlation_id is null` pero SÍ traen el
-- identificador de negocio dentro de `output` (corridas cerradas por
-- `apps/worker` antes de esta ronda). `apps/worker/src/handlers/
-- run-agent.ts` se adapta en el mismo cambio para escribir la columna
-- directamente desde ahora (ver ese archivo); la consulta REQ-171 pasa a
-- usar `where correlation_id = $1` en vez de `output->>'correlationId' = $1`
-- (ver `apps/worker/test/run-agent-handler.test.ts`).
alter table agent_runs add column if not exists correlation_id text;

create index if not exists ix_agent_runs_correlation on agent_runs (org_id, correlation_id);

-- Backfill: solo toca filas que todavía no tienen el dato en la columna
-- (nunca pisa un valor ya escrito, ni por 0017/agent-stores.pg.ts ni por
-- una reaplicación de esta misma migración -- `where correlation_id is
-- null` la hace segura de re-ejecutar sobre la misma fila sin cambiar
-- nada la segunda vez, aunque `schema_migrations`/el checksum ya impiden
-- que se reaplique de verdad).
update agent_runs
set correlation_id = output ->> 'correlationId'
where correlation_id is null
  and output is not null
  and output ->> 'correlationId' is not null;
