-- 0100_req041_junta_questions.sql
-- REQ-041 ("Diff de requisitos aplicado también a actas de junta de
-- aclaraciones, con ventana de 24h para preguntas fundadas (cita + numeral +
-- alternativa)"): historial INMUTABLE de corridas del generador determinista
-- de preguntas de junta (`packages/expediente/src/junta-questions.ts`).
-- Mismo precedente que `war_room_checklist_runs` (migración 0099) y
-- `collection_status_history` (migración 0094): el CÁLCULO vive en código,
-- esta tabla solo persiste cada corrida como registro de auditoría
-- append-only -- nunca se edita una corrida pasada, cada nueva ejecución
-- (p. ej. tras subir un acta de aclaraciones nueva) crea una fila nueva.
--
-- `questions`/`rejected` guardan el arreglo COMPLETO devuelto por
-- `generateJuntaQuestions` (incluida cada `sources[]`), para que el
-- historial sea auto-contenido y auditable sin tener que reconstruirlo
-- desde `requirement_items`/`requirement_conflicts`, que pueden cambiar
-- (nuevas versiones de bases, resolución de conflictos) después de esta
-- corrida.

create table if not exists junta_question_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  junta_aclaraciones_at timestamptz not null,
  questions_due_at timestamptz not null,
  within_window boolean not null,
  -- `JuntaQuestion[]` completo (incluye `sources[]` con documentId/página/cita
  -- de cada una) -- REQ-041/REQ-082: nunca se persiste una pregunta sin su
  -- arreglo `sources` (el generador ya lo garantiza; esta columna solo
  -- refleja fielmente lo que devolvió).
  questions jsonb not null,
  questions_count integer not null,
  -- Candidatos descartados por el guardrail (sin fuente verificable, tipo de
  -- conflicto no soportado, etc.) -- se conserva para auditoría de que el
  -- generador NUNCA fabricó una pregunta a partir de ellos.
  rejected jsonb not null default '[]',
  documents_used integer not null default 0,
  computed_at timestamptz not null default now(),
  computed_by uuid references users (id) on delete set null,
  correlation_id text,
  created_at timestamptz not null default now()
);

create index if not exists ix_junta_question_runs_org_tender on junta_question_runs (org_id, tender_id, computed_at desc);

-- RLS a mano (no `app.apply_org_rls`): deliberadamente SIN políticas de
-- UPDATE/DELETE -- con RLS habilitada y ninguna política para esas
-- operaciones, Postgres las deniega para app_role sin excepción. El
-- historial de preguntas de junta es append-only por diseño, mismo patrón
-- que `war_room_checklist_runs`: cualquier lectura (incluido `viewer`) puede
-- ver el historial completo; solo un rol de escritura puede generar una
-- corrida nueva.
alter table junta_question_runs enable row level security;

drop policy if exists sel_junta_question_runs on junta_question_runs;
create policy sel_junta_question_runs on junta_question_runs
  for select using (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists ins_junta_question_runs on junta_question_runs;
create policy ins_junta_question_runs on junta_question_runs
  for insert with check (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer}'::org_role[]))
  );
