-- 0022_fix_db05_change_event_invalidation.sql
-- Corrige DB-05 (docs/auditoria-1/db-api.md, ALTA): insertar un
-- `tender_change_events` no invalidaba automáticamente ningún dependiente.
-- Las columnas `invalidated_at`/`invalidated_reason` existían desde 0012
-- pero nunca se llenaban solas -- REQ-155/REQ-162 ("tolerancia cero") no
-- estaban cerrados a nivel de base de datos (la invalidación manual que
-- apps/api pudiera implementar en la capa de aplicación no sustituye esta
-- garantía: cualquier código, presente o futuro, que inserte un
-- `tender_change_events` la dispara igual).
--
-- Alcance: marca `invalidated_at`/`invalidated_reason` en
-- `proposals`/`requirement_items`/`compliance_items` del mismo `tender_id`
-- que aún no estuvieran invalidados (guard `invalidated_at is null`, no
-- pisa una invalidación previa con una razón más reciente pero menos
-- relevante), y marca `proposal_approvals.status = 'invalidated'` para las
-- aprobaciones `'approved'` de propuestas de ese mismo tender (REQ-162
-- aplicado a aprobaciones, ya con `invalidated_by_change_id` apuntando al
-- evento que la invalidó).
create or replace function app.invalidate_tender_dependents()
returns trigger
language plpgsql
as $$
declare
  v_reason text;
begin
  v_reason := format('Convocatoria modificada (%s), evento %s', new.change_kind, new.id);

  update proposals
    set invalidated_at = now(), invalidated_reason = v_reason
    where org_id = new.org_id and tender_id = new.tender_id and invalidated_at is null;

  update requirement_items
    set invalidated_at = now(), invalidated_reason = v_reason
    where org_id = new.org_id and tender_id = new.tender_id and invalidated_at is null;

  update compliance_items
    set invalidated_at = now(), invalidated_reason = v_reason
    where org_id = new.org_id and tender_id = new.tender_id and invalidated_at is null;

  update proposal_approvals
    set status = 'invalidated', invalidated_by_change_id = new.id
    where org_id = new.org_id
      and status = 'approved'
      and proposal_id in (select id from proposals where org_id = new.org_id and tender_id = new.tender_id);

  return new;
end;
$$;

drop trigger if exists trg_invalidate_tender_dependents on tender_change_events;
create trigger trg_invalidate_tender_dependents
  after insert on tender_change_events
  for each row execute function app.invalidate_tender_dependents();
