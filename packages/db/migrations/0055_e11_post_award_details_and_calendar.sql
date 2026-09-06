-- 0055_e11_post_award_details_and_calendar.sql
-- Ronda 5 (E11, apps/api): reconciliación honesta contra REQ-050..056 --
-- ver `apps/api/docs/e11-cobertura.md`. `post_award_followups` ya existía
-- (0006/0032) como modelo GENÉRICO (kind/label/dueDate/amount/notes); esta
-- migración agrega las columnas ESTRUCTURADAS que el propio requisito pide
-- explícitamente por tipo de seguimiento, sin inventar un motor nuevo:
--   - kind='hito'                 -> responsible_party (responsable con nombre/rol/correo)
--   - kind='garantia'             -> guarantee_type (tipo de garantía: cumplimiento/anticipo/vicios_ocultos/otro);
--                                    la VIGENCIA usa la columna `due_date` ya existente (fecha de vencimiento
--                                    de la garantía), documentado explícitamente en schemas.ts para no
--                                    duplicar semántica de fecha.
--   - kind='facturacion'          -> cfdi_reference (folio fiscal/UUID del CFDI) + acceptance_date (fecha en
--                                    que la dependencia dio por aceptada la factura -- dispara el cómputo del
--                                    plazo de pago, ver lib/expediente/business-days.ts).
--   - kind='penalizacion' |
--     kind='convenio_modificatorio' -> modification_reference (número/expediente de la pena convencional o
--                                    del convenio modificatorio registrado; el monto reutiliza `amount`).
-- Ninguna columna es NOT NULL: son datos capturados por kind, no aplican a
-- todos los registros simultáneamente (un 'hito' no tiene `cfdi_reference`).
alter table post_award_followups add column if not exists responsible_party text;
alter table post_award_followups add column if not exists guarantee_type text;
alter table post_award_followups add column if not exists cfdi_reference text;
alter table post_award_followups add column if not exists acceptance_date date;
alter table post_award_followups add column if not exists modification_reference text;

-- ---------------------------------------------------------------------------
-- calendar_holidays: calendario OFICIAL de días inhábiles (REQ-050/REQ-056).
--
-- DECISIÓN DE DISEÑO (igual precedente que `source_runs`, 0013): tabla de
-- PLATAFORMA, no por organización -- el calendario de días inhábiles
-- federales es el mismo para todas las organizaciones, no un dato de
-- tenant. RLS: lectura abierta a cualquier rol autenticado de la
-- aplicación (`app_role`, dato público no sensible); escritura (insertar/
-- actualizar/borrar) restringida a superadmin, igual que `source_runs`.
--
-- SIN INVENTAR FECHAS: esta migración NO precarga ningún feriado. Cargar
-- el calendario oficial vigente es tarea explícita del administrador vía
-- `POST /admin/calendar-holidays` (cada fila exige `source_url` +
-- `source_consulted_on`, nunca una fecha "porque se sabe de memoria" -- ver
-- docs/legal/verificacion-legal.md, que documenta que este proyecto NO
-- pudo verificar en línea, en esta ronda, el lineamiento SABG/DOF con el
-- calendario oficial completo de días inhábiles). Con la tabla vacía, el
-- motor de plazos (`business-days.ts`) sigue excluyendo únicamente
-- sábados/domingos y lo declara explícitamente en `calendarNote` de la
-- respuesta de la API -- nunca finge tener un calendario completo.
create table if not exists calendar_holidays (
  id uuid primary key default gen_random_uuid(),
  jurisdiction text not null default 'federal',
  year integer not null,
  holiday_date date not null,
  label text not null,
  source_url text not null,
  source_consulted_on date not null,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (jurisdiction, holiday_date)
);

create index if not exists ix_calendar_holidays_jurisdiction_year on calendar_holidays (jurisdiction, year);

alter table calendar_holidays enable row level security;

drop policy if exists sel_calendar_holidays on calendar_holidays;
create policy sel_calendar_holidays on calendar_holidays for select using (true);

drop policy if exists ins_calendar_holidays on calendar_holidays;
create policy ins_calendar_holidays on calendar_holidays for insert with check (app.is_superadmin());

drop policy if exists upd_calendar_holidays on calendar_holidays;
create policy upd_calendar_holidays on calendar_holidays for update using (app.is_superadmin()) with check (app.is_superadmin());

drop policy if exists del_calendar_holidays on calendar_holidays;
create policy del_calendar_holidays on calendar_holidays for delete using (app.is_superadmin());
