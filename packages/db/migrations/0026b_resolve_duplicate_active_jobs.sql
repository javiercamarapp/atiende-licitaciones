-- 0026b_resolve_duplicate_active_jobs.sql
-- Reverificación de apps/worker sobre PROPOSAL-02 (0027_jobs_dedupe_and_cancelled.sql,
-- ya incorporada y aplicada): detectó que `create unique index
-- ux_jobs_kind_jobkey_active` FALLA si el entorno que aplica las
-- migraciones ya tiene jobs activos duplicados por (kind, jobKey) --
-- p. ej. insertados antes de que `JobQueue.enqueue()` tuviera el advisory
-- lock, o por un script ajeno a la aplicación. Como 0027 ya está commiteada
-- y aplicada (no se edita una migración existente), esta migración
-- INTERMEDIA se numera para ejecutarse DESPUÉS de 0026 y ANTES de 0027
-- (`0026b` ordena alfabéticamente entre ambas: `_` (0x5F) < `b` (0x62) <
-- dígito `7`), resolviendo cualquier duplicado activo preexistente ANTES
-- de que 0027 intente crear el índice único.
--
-- Nota sobre el estado usado para resolver duplicados: el enum `job_status`
-- todavía NO tiene el valor `'cancelled'` en este punto de la secuencia de
-- migraciones (lo agrega la propia 0027, que corre DESPUÉS de esta). Por
-- eso se usa `'dead'` (ya existente desde 0003) en vez de `'cancelled'`
-- como pedía la reverificación -- usar un valor de enum antes de que exista
-- no es posible. El `last_error` explica exactamente por qué se resolvió,
-- para que sea indistinguible de un dead-letter común solo si alguien no
-- lee `last_error` (limitación aceptada y documentada, coherente con el
-- motivo original por el que 0027 introdujo `'cancelled'`).
--
-- Función reutilizable (no solo un parche de una sola vez): queda disponible
-- para invocarse de nuevo en el futuro si alguna vez hace falta reconstruir
-- el índice (DROP + recrear), o como tarea de mantenimiento periódica.
create or replace function app.resolve_duplicate_active_jobs()
returns integer
language plpgsql
as $$
declare
  v_resolved integer;
begin
  with ranked as (
    select id, row_number() over (
      partition by kind, (payload ->> 'jobKey')
      -- Se conserva el job ACTIVO MÁS RECIENTE por (kind, jobKey) (orden
      -- descendente, rn=1 = el más nuevo); los más antiguos se resuelven,
      -- tal como pidió la reverificación ("marca los más antiguos").
      order by created_at desc, id desc
    ) as rn
    from jobs
    where payload ? 'jobKey' and status in ('queued', 'running')
  )
  update jobs
  set status = 'dead',
      last_error = trim(both ' ' from coalesce(last_error, '') ||
        ' [resuelto por app.resolve_duplicate_active_jobs: duplicado activo de (kind, jobKey); se conservó el más reciente]')
  from ranked
  where jobs.id = ranked.id and ranked.rn > 1;

  get diagnostics v_resolved = row_count;
  return v_resolved;
end;
$$;

-- Ejecuta la resolución una vez, en el momento en que se despliega esta
-- migración (antes de que 0027 cree el índice único a continuación).
select app.resolve_duplicate_active_jobs();
