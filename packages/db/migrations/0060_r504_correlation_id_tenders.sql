-- 0060_r504_correlation_id_tenders.sql
-- R5-04 (docs/auditoria-2/api-ronda5.md, MEDIA): la migración 0056 agregó
-- `correlation_id` a `source_runs`/`proposals`/`package_manifests`/`jobs`/
-- `audit_log` explícitamente para cubrir la cadena "convocatoria -> matriz
-- -> propuesta -> paquete -> archivo", pero `tenders`/`tender_versions`
-- (la CONVOCATORIA en sí, el primer eslabón) nunca tuvieron la columna --
-- ninguna convocatoria era correlacionable, ni con la mejor intención del
-- cliente de `POST /internal/tenders/ingest` (que sí acepta/propaga
-- `X-Correlation-Id` desde la migración 0056 a nivel de plugin, pero nunca
-- lo persistía en ningún dato de esa request).
alter table tenders add column if not exists correlation_id text;
alter table tender_versions add column if not exists correlation_id text;

create index if not exists ix_tenders_correlation on tenders (correlation_id);
create index if not exists ix_tender_versions_correlation on tender_versions (correlation_id);
