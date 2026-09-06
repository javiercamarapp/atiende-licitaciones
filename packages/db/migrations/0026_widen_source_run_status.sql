-- 0026_widen_source_run_status.sql
-- Incorpora PROPOSAL-01-widen-source-run-status.sql (apps/worker/db-proposals/,
-- WK-07, docs/auditoria-1/worker.md), propuesta por el agente de
-- apps/worker y aplicada aquí por quien mantiene packages/db, coordinado
-- por el orquestador.
--
-- `source_run_status` (0013_source_runs.sql) solo tenía 6 valores; apps/worker
-- distingue 8 estados finos reales (`SourceRunFineState`) y proyectaba
-- `rate_limited`/`not_configured`/`ingest_failed` a `'failed'`, perdiendo
-- la distinción entre "nunca verificado" (acción de gobierno),
-- "limitado por tasa" (transitorio) e "ingesta falló pero la fuente sí
-- respondió" (problema de apps/api, no de la fuente) -- relevante para
-- REQ-148/149 (estados explícitos, nunca silencio interpretado como "cero
-- oportunidades").
--
-- Solo se AGREGAN valores (retrocompatible: ninguna fila existente cambia).
-- No se usan en esta misma migración (restricción de Postgres: un valor de
-- enum recién agregado no puede usarse en la misma transacción).
alter type source_run_status add value if not exists 'rate_limited';
alter type source_run_status add value if not exists 'not_configured';
alter type source_run_status add value if not exists 'ingest_failed';
