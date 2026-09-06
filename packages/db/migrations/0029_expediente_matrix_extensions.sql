-- 0029_expediente_matrix_extensions.sql
-- Ronda 3 (E6, apps/api): columnas necesarias para persistir la salida real
-- de `@atiende/expediente` (RequirementMatrixBuilder) sobre `tender_documents`
-- / `requirement_items`, más una tabla nueva para conflictos entre
-- documentos (REQ-156/REQ-166). Solo adiciones -- ninguna migración previa
-- se edita.

-- ---------------------------------------------------------------------------
-- tender_documents: distingue tipo de documento (bases/anexo/aclaración),
-- versión de origen (para poder recalcular la matriz cuando llega una nueva
-- versión de bases manteniendo historial) y estado explícito de extracción
-- de texto. `text_extraction_status = 'requires_ocr'` es el estado honesto
-- para un PDF sin capa de texto (sin OCR real en esta ronda) -- NUNCA se
-- deja `extracted_text` vacío en silencio como si el documento no tuviera
-- contenido relevante.
-- ---------------------------------------------------------------------------
alter table tender_documents add column if not exists document_kind text not null default 'bases';
alter table tender_documents
  add constraint chk_tender_documents_kind
  check (document_kind in ('bases', 'anexo', 'aclaracion', 'otro'));

alter table tender_documents add column if not exists tender_version_id uuid references tender_versions (id) on delete set null;
alter table tender_documents add column if not exists uploaded_by uuid references users (id) on delete set null;
alter table tender_documents add column if not exists original_filename text;
alter table tender_documents add column if not exists mime_type text;
alter table tender_documents add column if not exists text_extraction_status text not null default 'pending';
alter table tender_documents
  add constraint chk_tender_documents_extraction_status
  check (text_extraction_status in ('pending', 'extracted', 'requires_ocr', 'failed'));

-- ---------------------------------------------------------------------------
-- requirement_items: campos de gestión (REQ-156, docs/AMPLIACION-BACKOFFICE
-- §5) que la matriz de `@atiende/expediente` produce y que la ronda 1 no
-- modelaba: obligatoriedad tri-estado, tipo, responsable, cláusula, plazo
-- explícito con offset, estado de gestión editable por rol writer+,
-- procedencia del extractor y confianza.
-- ---------------------------------------------------------------------------
alter table requirement_items add column if not exists obligatoriedad text not null default 'obligatorio';
alter table requirement_items
  add constraint chk_requirement_items_obligatoriedad
  check (obligatoriedad in ('obligatorio', 'opcional', 'condicional'));

alter table requirement_items add column if not exists requirement_kind text not null default 'administrativo';
alter table requirement_items
  add constraint chk_requirement_items_kind
  check (requirement_kind in ('tecnico', 'economico', 'legal', 'administrativo', 'anexo'));

alter table requirement_items add column if not exists clause_ref text;
alter table requirement_items add column if not exists deadline_at timestamptz;
alter table requirement_items add column if not exists responsible_role text;
alter table requirement_items add column if not exists assigned_to uuid references users (id) on delete set null;

-- Estado de GESTIÓN del requisito (distinto de `compliance_items.status`,
-- que es el cumplimiento documental): editable por escritura (writer+).
alter table requirement_items add column if not exists matrix_status text not null default 'pendiente';
alter table requirement_items
  add constraint chk_requirement_items_matrix_status
  check (matrix_status in ('pendiente', 'en_progreso', 'cumplido', 'bloqueado', 'no_evaluable'));

alter table requirement_items add column if not exists extracted_by text not null default 'rule';
alter table requirement_items
  add constraint chk_requirement_items_extracted_by
  check (extracted_by in ('rule', 'llm'));

alter table requirement_items add column if not exists confidence numeric(3, 2);
alter table requirement_items add column if not exists topic_key text;
alter table requirement_items add column if not exists required_evidence text[] not null default '{}';

create index if not exists ix_requirement_items_topic on requirement_items (org_id, tender_id, topic_key);
create index if not exists ix_requirement_items_assigned on requirement_items (org_id, assigned_to);

-- ---------------------------------------------------------------------------
-- requirement_conflicts: conflictos detectados por `RequirementMatrixBuilder`
-- entre documentos (plazo u obligatoriedad contradictorios) -- se persisten
-- como incidentes visibles y accionables (resolución humana explícita), en
-- vez de solo un campo derivado en memoria.
-- ---------------------------------------------------------------------------
create table if not exists requirement_conflicts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  topic_key text not null,
  kind text not null,
  description text not null,
  requirement_ids uuid[] not null default '{}',
  status text not null default 'escalado',
  resolved_at timestamptz,
  resolved_by uuid references users (id) on delete set null,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table requirement_conflicts
  add constraint chk_requirement_conflicts_kind
  check (kind in ('deadline_mismatch', 'obligatoriedad_mismatch', 'duplicate_ambiguous'));
alter table requirement_conflicts
  add constraint chk_requirement_conflicts_status
  check (status in ('abierto', 'escalado', 'resuelto'));

create index if not exists ix_requirement_conflicts_org_tender on requirement_conflicts (org_id, tender_id);

drop trigger if exists trg_requirement_conflicts_updated_at on requirement_conflicts;
create trigger trg_requirement_conflicts_updated_at
  before update on requirement_conflicts
  for each row execute function app.set_updated_at();

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('requirement_conflicts', all_roles, write_roles);
end;
$$;
