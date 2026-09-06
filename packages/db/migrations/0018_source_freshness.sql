-- 0018_source_freshness.sql
-- `source_runs` (0013) es de plataforma y su RLS es "solo superadmin" (no
-- tiene org_id, no aplica el patrón multi-tenant). Ronda 2 necesita que
-- CUALQUIER organización pueda ver la frescura agregada por fuente (última
-- corrida exitosa, estado, intentos) para mostrarla en su propio back
-- office (REQ-149/REQ-150), sin poder ver el detalle crudo de evidencia de
-- cada corrida (eso sigue siendo solo-superadmin). Se expone vía una
-- función SECURITY DEFINER de alcance mínimo (solo las columnas de
-- "frescura", nunca `evidence`/`coverage` crudos), invocable por cualquier
-- usuario autenticado sin importar su rol/organización (la frescura de una
-- fuente pública no es un dato de tenant).
create or replace function app.source_freshness()
returns table (
  source_id text,
  status source_run_status,
  last_success_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  attempts integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select distinct on (sr.source_id)
    sr.source_id, sr.status, sr.last_success_at, sr.started_at, sr.finished_at, sr.attempts
  from source_runs sr
  order by sr.source_id, sr.started_at desc
$$;
