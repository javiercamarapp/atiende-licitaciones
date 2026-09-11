-- 0099_req040_war_room_checklist.sql
-- REQ-040 ("sala de guerra" el día de apertura): historial INMUTABLE de
-- corridas del `WarRoomChecklist` (packages/expediente) para un expediente
-- concreto -- checklist anti-desechamiento (estado real del expediente
-- frente al riesgo de que la convocante lo deseche por incompleto),
-- cuenta regresiva a la fecha límite, verificación del hash del ZIP
-- realmente ensamblado contra su propio manifiesto, y holgura obligatoria
-- de 24h antes de la fecha límite. Mismo precedente que
-- `collection_status_history` (migración 0094): el CÁLCULO vive en código
-- (`packages/expediente/src/war-room-checklist.ts`), esta tabla solo
-- persiste cada corrida como registro de auditoría append-only -- nunca se
-- edita una corrida pasada, cada nueva ejecución (p. ej. tras corregir un
-- pendiente) crea una fila nueva.

create table if not exists war_room_checklist_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  overall_status text not null check (overall_status in ('verde', 'ambar', 'rojo')),
  -- `WarRoomItemResult[]` completo (dimension/status/detail/evidence por
  -- las 4 dimensiones), para que el historial sea auto-contenido sin tener
  -- que reconstruirlo desde otras tablas que pudieron cambiar desde
  -- entonces.
  items jsonb not null,
  -- Horas (con fracción, puede ser negativa si ya venció) hasta
  -- `submission_deadline_iso` al momento de esta corrida; NULL si la
  -- convocatoria no tenía fecha límite fijada en ese momento.
  hours_until_deadline numeric,
  submission_deadline_iso timestamptz,
  computed_at timestamptz not null default now(),
  run_by uuid references users (id) on delete set null,
  correlation_id text,
  created_at timestamptz not null default now()
);

create index if not exists ix_war_room_checklist_runs_org_proposal on war_room_checklist_runs (org_id, proposal_id, computed_at desc);

-- RLS a mano (no `app.apply_org_rls`): deliberadamente SIN políticas de
-- UPDATE/DELETE -- con RLS habilitada y ninguna política para esas
-- operaciones, Postgres las deniega para app_role sin excepción. El
-- historial de "sala de guerra" es append-only por diseño, mismo patrón que
-- `collection_status_history`/`contract_status_history`: cualquier lectura
-- (incluido `viewer`) puede ver el historial completo; solo un rol de
-- escritura puede correr un checklist nuevo.
alter table war_room_checklist_runs enable row level security;

drop policy if exists sel_war_room_checklist_runs on war_room_checklist_runs;
create policy sel_war_room_checklist_runs on war_room_checklist_runs
  for select using (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists ins_war_room_checklist_runs on war_room_checklist_runs;
create policy ins_war_room_checklist_runs on war_room_checklist_runs
  for insert with check (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer}'::org_role[]))
  );
