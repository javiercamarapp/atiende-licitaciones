-- 0056_correlation_id_propagation.sql
-- REQ-171 (extiende REQ-084 al ciclo completo del expediente): trazas
-- correlacionadas de extremo a extremo, con un `correlation_id` único
-- reconstruible en auditoría, desde la convocatoria hasta cada archivo del
-- expediente.
--
-- `agent_runs`/`tool_calls` YA tenían `correlation_id` (0017_ronda2_extensions.sql)
-- para agrupar pasos de un mismo run de agente -- no se toca aquí. Esta
-- migración agrega la columna a las piezas que todavía no la tenían y que
-- forman la cadena "convocatoria -> matriz -> propuesta -> paquete ->
-- archivo": `audit_log` (bitácora general, ver `apps/api/src/lib/audit.ts`),
-- `jobs` (recordatorios/tareas encoladas), `source_runs` (ingesta de la
-- convocatoria), `proposals` (la "versión de propuesta" vive en esta tabla,
-- no hay una `proposal_versions` separada) y `package_manifests`
-- (manifiesto del paquete final).
alter table audit_log add column if not exists correlation_id text;
alter table jobs add column if not exists correlation_id text;
alter table source_runs add column if not exists correlation_id text;
alter table proposals add column if not exists correlation_id text;
alter table package_manifests add column if not exists correlation_id text;

create index if not exists ix_audit_log_correlation on audit_log (correlation_id);
create index if not exists ix_jobs_correlation on jobs (correlation_id);
create index if not exists ix_source_runs_correlation on source_runs (correlation_id);
create index if not exists ix_proposals_correlation on proposals (correlation_id);
create index if not exists ix_package_manifests_correlation on package_manifests (correlation_id);
