-- 0045_doc_fix_db11_worker_role_grants_comment.sql
-- Corrige DB-11 (docs/auditoria-1/db-api-reverificacion.md, BAJA,
-- documentación -- sin impacto de seguridad real): el comentario de
-- `0028_worker_role.sql:74` afirma que `worker_role` queda "explícitamente
-- SIN grants sobre ninguna otra tabla del esquema", pero esa misma
-- migración (línea 60) hace `grant app_role to worker_role`, con lo que
-- `worker_role` SÍ hereda los privilegios amplios de `app_role` (incluidos
-- los de `ALTER DEFAULT PRIVILEGES` de 0001 sobre TODAS las tablas de los
-- esquemas `public`/`app`). No es una vulnerabilidad -- RLS neutraliza el
-- acceso real y `worker-role-and-job-proposals.test.ts` ya lo prueba
-- explícitamente -- pero podría inducir a un futuro mantenedor a confiar
-- en un límite de GRANT que en realidad no existe (el único control real
-- es RLS, no el listado de `grant ... to worker_role`).
--
-- Siguiendo el mismo criterio que la corrección del comentario de 0023
-- (ver migración de esta misma ronda): se corrige documentando el estado
-- real vía un objeto `COMMENT ON ROLE` real de Postgres, en vez de editar
-- el archivo 0028 ya aplicado.
comment on role worker_role is
  'NOLOGIN/NOSUPERUSER/NOBYPASSRLS (0028). Hereda los privilegios amplios '
  'de app_role via "grant app_role to worker_role" (incl. ALTER DEFAULT '
  'PRIVILEGES de 0001 sobre todas las tablas de public/app) -- el comentario '
  'de 0028_worker_role.sql:74 ("sin grants sobre ninguna otra tabla del '
  'esquema") es impreciso en ese sentido (ver DB-11, '
  'docs/auditoria-1/db-api-reverificacion.md). El ÚNICO control real de '
  'acceso de worker_role es RLS (políticas "current_user = ''worker_role''" '
  'en jobs/source_runs/agent_runs), no el GRANT: no asumir un límite de '
  'privilegios de tabla que no existe.';
