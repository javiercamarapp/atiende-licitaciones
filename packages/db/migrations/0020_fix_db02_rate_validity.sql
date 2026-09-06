-- 0020_fix_db02_rate_validity.sql
-- Corrige DB-02 (docs/auditoria-1/db-api.md, ALTA):
-- `app.enforce_approved_rate` (0014_pricing.sql) validaba `status='approved'`
-- y que la tarifa perteneciera a la organización correcta, pero NUNCA
-- validaba vigencia (`valid_from`/`valid_until`). Una tarifa aprobada pero
-- vencida (o que todavía no entra en vigor) podía usarse igual en una línea
-- de propuesta económica -- contradice REQ-029/REQ-164 ("no inventar
-- precios") aplicado a vigencia, y REQ-023 (vigencia se compara contra la
-- fecha del acto/uso, nunca se asume vigente sin verificar).

create or replace function app.enforce_approved_rate()
returns trigger
language plpgsql
as $$
declare
  v_status rate_status;
  v_org uuid;
  v_valid_from date;
  v_valid_until date;
begin
  select status, org_id, valid_from, valid_until
    into v_status, v_org, v_valid_from, v_valid_until
    from approved_rates where id = new.approved_rate_id;

  if v_status is null then
    raise exception 'approved_rate_id % no existe', new.approved_rate_id;
  end if;

  if v_status <> 'approved' then
    raise exception 'La tarifa % no está aprobada (status=%): no puede usarse en una propuesta económica', new.approved_rate_id, v_status;
  end if;

  if v_org <> new.org_id then
    raise exception 'La tarifa % pertenece a otra organización', new.approved_rate_id;
  end if;

  if v_valid_from is not null and current_date < v_valid_from then
    raise exception 'La tarifa % todavía no está vigente (vigente desde %)', new.approved_rate_id, v_valid_from;
  end if;

  if v_valid_until is not null and current_date > v_valid_until then
    raise exception 'La tarifa % ya venció (vigente hasta %): no puede usarse en una propuesta económica', new.approved_rate_id, v_valid_until;
  end if;

  return new;
end;
$$;
