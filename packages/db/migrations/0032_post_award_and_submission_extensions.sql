-- 0032_post_award_and_submission_extensions.sql
-- Ronda 3 (E9/E11, apps/api): columnas para que `submissions` registre
-- honestamente solo la DECLARACIÓN del usuario de haber presentado (nunca un
-- envío real -- A15), y para que `post_award_followups` module la fuente
-- legal de un plazo calculado (p. ej. pago a 17 días hábiles, LAASSP nueva
-- Art. 73 -- ver docs/legal/verificacion-legal.md, fila REQ-105) y su
-- vínculo con el recordatorio encolado en `jobs` (sin envío externo).

-- ---------------------------------------------------------------------------
-- submissions
-- ---------------------------------------------------------------------------
alter table submissions add column if not exists acknowledgement_storage_ref text;
alter table submissions add column if not exists acknowledgement_file_hash text;
alter table submissions add column if not exists notes text;

-- ---------------------------------------------------------------------------
-- post_award_followups
-- ---------------------------------------------------------------------------
alter table post_award_followups add column if not exists legal_reference text;
alter table post_award_followups add column if not exists reminder_lead_days integer not null default 3;
alter table post_award_followups add column if not exists job_id uuid references jobs (id) on delete set null;
alter table post_award_followups add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists ix_post_award_followups_due on post_award_followups (org_id, due_date);
