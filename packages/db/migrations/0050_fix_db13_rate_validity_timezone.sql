-- 0050_fix_db13_rate_validity_timezone.sql
-- Corrige DB-13 (MEDIA, nuevo) --
-- docs/auditoria-1/db-api-seguridad-reverificacion.md:
--
-- `app.enforce_approved_rate` (0042_fix_db02_db10_rate_validity_submission_deadline.sql)
-- compara `submission_deadline::date` contra `valid_from`/`valid_until`,
-- pero ese cast `::date` sobre un `timestamptz` depende SIEMPRE del
-- `TimeZone` de la SESIÓN de Postgres -- ningún archivo de `packages/db`
-- fijaba explícitamente ese `TimeZone`. Confirmado empíricamente
-- (reverificación): con `submission_deadline = '2026-01-15T05:00:00Z'` y
-- una tarifa `valid_until = '2026-01-14'`, el veredicto (aceptar/rechazar)
-- cambia según la sesión evalúe en `America/Mexico_City` (UTC-6: ese
-- instante cae en 2026-01-14 -> aceptado) o en `UTC` (cae en 2026-01-15 ->
-- rechazado). Un Postgres de producción con `TimeZone=UTC` (configuración
-- por defecto muy común en la nube) evaluaría el MISMO dato con el
-- resultado OPUESTO al de un entorno de desarrollo cuyo `TZ` de sistema
-- operativo coincidiera por casualidad con México.
--
-- Corrección: usar `timestamptz AT TIME ZONE 'America/Mexico_City'`
-- (produce un `timestamp` ya anclado a esa zona) en vez de un `::date`
-- desnudo, tanto para `submission_deadline` como para el fallback
-- `current_date`/`now()` (mismo criterio ya usado en apps/api,
-- lib/expediente/dates.ts). El resultado deja de depender del `TimeZone`
-- de sesión: da el MISMO veredicto sin importar si la sesión está en UTC,
-- Asia/Tokyo o cualquier otra zona.

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

  -- DB-13: SIEMPRE se evalúa el día calendario en America/Mexico_City, sin
  -- importar el `TimeZone` de la sesión que ejecuta el trigger.
  v_reference_date := coalesce(
    (v_submission_deadline at time zone 'America/Mexico_City')::date,
    (now() at time zone 'America/Mexico_City')::date
  );

  if v_valid_from is not null and v_reference_date < v_valid_from then
    raise exception 'La tarifa % todavía no está vigente a la fecha de presentación (vigente desde %)', new.approved_rate_id, v_valid_from;
  end if;

  if v_valid_until is not null and v_reference_date > v_valid_until then
    raise exception 'La tarifa % ya está vencida a la fecha de presentación (vigente hasta %): no puede usarse en una propuesta económica', new.approved_rate_id, v_valid_until;
  end if;

  return new;
end;
$$;

comment on function app.enforce_approved_rate() is
  'DB-02/DB-10/DB-13: valida estado=approved, misma organizacion, y vigencia '
  '(valid_from/valid_until) contra la fecha de presentacion del tender '
  '(submission_deadline), NUNCA contra "hoy" -- y esa comparacion de dia '
  'calendario SIEMPRE se hace en America/Mexico_City via "AT TIME ZONE", '
  'nunca con un ::date desnudo que heredaria el TimeZone de la sesion.';
