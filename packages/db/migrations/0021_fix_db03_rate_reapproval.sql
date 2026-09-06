-- 0021_fix_db03_rate_reapproval.sql
-- Corrige DB-03 (docs/auditoria-1/db-api.md, ALTA): no existía ningún
-- mecanismo que revirtiera la aprobación de una tarifa si su precio (u otro
-- campo material) cambiaba después de aprobada. `UPDATE approved_rates SET
-- unit_price = ... WHERE status = 'approved'` tenía éxito y el status
-- seguía `'approved'` -- contradice el espíritu de REQ-162 (cambiar un
-- insumo ya aprobado exige nueva revisión) aplicado a precios.
--
-- Regla: si la fila YA estaba `approved` y la sentencia UPDATE no está
-- explícitamente cambiando `status` (es decir, sigue viniendo `'approved'`
-- porque el llamador no lo tocó) pero SÍ cambia algún campo material
-- (unit_price, item_code, unit, currency, valid_from, valid_until),
-- entonces se fuerza `status='draft'` y se limpian `approved_by`/`approved_at`
-- -- exige nueva aprobación explícita (ver POST /company/rates/:id/approve
-- en apps/api). Un UPDATE que SÍ fija `status` explícitamente (el flujo
-- normal de aprobación/archivo) nunca se revoca a sí mismo.
create or replace function app.revoke_rate_approval_on_material_change()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'approved' and new.status = 'approved' and (
    new.unit_price is distinct from old.unit_price
    or new.item_code is distinct from old.item_code
    or new.unit is distinct from old.unit
    or new.currency is distinct from old.currency
    or new.valid_from is distinct from old.valid_from
    or new.valid_until is distinct from old.valid_until
  ) then
    new.status := 'draft';
    new.approved_by := null;
    new.approved_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_revoke_rate_approval_on_material_change on approved_rates;
create trigger trg_revoke_rate_approval_on_material_change
  before update on approved_rates
  for each row execute function app.revoke_rate_approval_on_material_change();
