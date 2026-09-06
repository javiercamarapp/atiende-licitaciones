-- 0046_doc_fix_sha256_pg_version_comment.sql
-- Corrige la nota de portabilidad señalada en
-- docs/auditoria-1/db-api-reverificacion.md (sección "4. Migraciones"):
-- `0023_fix_db06_audit_log_hash_chain.sql:8` afirma que `sha256()` núcleo
-- de Postgres está "disponible desde PG11", pero en realidad es una
-- función núcleo desde **PG14** (en PG11-13 requiere la extensión
-- `pgcrypto` vía `digest(data, 'sha256')`, no la función `sha256()` a
-- secas usada aquí). Sin efecto en los tests (PGlite 18.3), pero relevante
-- para verificar contra la versión real de Postgres de producción antes de
-- desplegar esta cadena de hashes.
--
-- Se corrige documentando el estado real vía `COMMENT ON FUNCTION` (objeto
-- real de Postgres, consultable con `\df+`/`obj_description`), en vez de
-- editar el archivo 0023 ya aplicado.
comment on function app.audit_log_chain_insert() is
  'Calcula el hash chain de audit_log con sha256() nucleo de Postgres. '
  'Nota de portabilidad corregida (ver docs/auditoria-1/db-api-reverificacion.md '
  'y migracion 0046): sha256() nucleo esta disponible desde PG14, NO desde '
  'PG11 como decia el comentario original de 0023_fix_db06_audit_log_hash_chain.sql:8 '
  '(en PG11-13 solo existe via la extension pgcrypto, digest(data, ''sha256'')). '
  'Verificar la version real de Postgres de produccion antes de desplegar.';

comment on function app.verify_audit_log_chain() is
  'Verifica el hash chain de audit_log con sha256() nucleo de Postgres '
  '(disponible desde PG14, no PG11 -- ver comentario de '
  'app.audit_log_chain_insert() y migracion 0046).';
