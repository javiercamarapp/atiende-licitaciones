-- 0042_fix_db02_db10_rate_validity_submission_deadline.sql
-- Corrige DB-02 (reabierto) / DB-10 (nuevo, MEDIA) --
-- docs/auditoria-1/db-api-reverificacion.md:
--
-- `app.enforce_approved_rate` (0014_pricing.sql, corregida en
-- 0020_fix_db02_rate_validity.sql) valida vigencia (`valid_from`/
-- `valid_until`) SOLO contra `current_date` ("hoy"), nunca contra la fecha
-- de presentación del acto (`tenders.submission_deadline`, existente desde
-- 0005_tenders_core.sql). REQ-023 exige que la vigencia se compare contra
-- la fecha del acto/uso, no contra "hoy": una tarifa vigente hoy pero que
-- YA habría estado vencida (o que aún no habría entrado en vigor) a la
-- fecha en que se presentó la propuesta no debería poder usarse en esa
-- propuesta -- y viceversa, el trigger actual también aceptaba
-- incorrectamente esos casos.
--
-- Reataque confirmado (ver DB-10): tarifa aprobada con
-- `valid_until = hoy + 5`, tender con `submission_deadline = hoy + 60` ->
-- el INSERT en `proposal_pricing_lines` se aceptaba porque `hoy <=
-- valid_until`, aunque la tarifa ya estaría vencida para cuando se
-- presente la propuesta.
--
-- Corrección: resolver `submission_deadline` vía `new.proposal_id ->
-- proposals.tender_id -> tenders.submission_deadline` y comparar
-- `coalesce(submission_deadline::date, current_date)` contra
-- `valid_from`/`valid_until`, con fallback a `current_date` cuando el
-- tender todavía no tiene plazo de presentación fijado (preserva el
-- comportamiento de 0020 para ese caso, ya cubierto por
-- audit-db02-rate-validity.test.ts, que siembra tenders sin
-- submission_deadline).

create or replace function app.enforce_approved_rate()
returns trigger
language plpgsql
as $$
declare
  v_status rate_status;
  v_org uuid;
  v_valid_from date;
  v_valid_until date;
  v_submission_deadline timestamptz;
  v_reference_date date;
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

  select t.submission_deadline
    into v_submission_deadline
    from proposals p
    join tenders t on t.id = p.tender_id
   where p.id = new.proposal_id;

  -- DB-10/REQ-023: la referencia de vigencia es la fecha de PRESENTACIÓN
  -- del acto, no "hoy". Si el tender aún no tiene `submission_deadline`
  -- fijado (NULL), se usa `current_date` como mejor aproximación disponible
  -- (comportamiento previo de 0020, preservado a propósito).
  v_reference_date := coalesce(v_submission_deadline::date, current_date);

  if v_valid_from is not null and v_reference_date < v_valid_from then
    raise exception 'La tarifa % todavía no está vigente a la fecha de presentación (vigente desde %)', new.approved_rate_id, v_valid_from;
  end if;

  if v_valid_until is not null and v_reference_date > v_valid_until then
    raise exception 'La tarifa % ya está vencida a la fecha de presentación (vigente hasta %): no puede usarse en una propuesta económica', new.approved_rate_id, v_valid_until;
  end if;

  return new;
end;
$$;
