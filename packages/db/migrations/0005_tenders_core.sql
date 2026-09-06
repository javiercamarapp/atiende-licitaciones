-- 0005_tenders_core.sql
-- Dominio de licitaciones: convocatorias, matches (scoring), decisiones
-- go/no-go, documentos de bases, requisitos extraídos y checklist de
-- cumplimiento documental.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tender_status') then
    create type tender_status as enum (
      'discovered', 'in_review', 'go', 'no_go', 'in_progress', 'submitted', 'won', 'lost', 'cancelled'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'go_no_go_decision') then
    create type go_no_go_decision as enum ('go', 'no_go');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'compliance_status') then
    create type compliance_status as enum ('pending', 'in_progress', 'complete', 'not_applicable', 'rejected');
  end if;
end
$$;

-- Convocatoria (licitación) ingerida desde una fuente externa (p.ej. PLACSP).
create table if not exists tenders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  source text not null,
  external_id text not null,
  title text not null,
  contracting_body text,
  cpv_codes text[] not null default '{}',
  budget_amount numeric(14, 2),
  currency text not null default 'EUR',
  submission_deadline timestamptz,
  published_at timestamptz,
  url text,
  status tender_status not null default 'discovered',
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, external_id)
);

create index if not exists ix_tenders_org_status on tenders (org_id, status);
create index if not exists ix_tenders_deadline on tenders (org_id, submission_deadline);

drop trigger if exists trg_tenders_updated_at on tenders;
create trigger trg_tenders_updated_at
  before update on tenders
  for each row execute function app.set_updated_at();

-- Resultado de matching (scoring) de una convocatoria contra el perfil de la organización.
create table if not exists tender_matches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  score numeric(5, 2) not null,
  criteria jsonb not null default '{}'::jsonb,
  explanation text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_tender_matches_org on tender_matches (org_id, tender_id);

drop trigger if exists trg_tender_matches_updated_at on tender_matches;
create trigger trg_tender_matches_updated_at
  before update on tender_matches
  for each row execute function app.set_updated_at();

-- Decisión go/no-go (requiere rol con capacidad de decisión, ver RLS 0008).
create table if not exists go_no_go_decisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  decision go_no_go_decision not null,
  reasons text[] not null default '{}',
  decided_by uuid references users (id) on delete set null,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_go_no_go_org_tender on go_no_go_decisions (org_id, tender_id);

drop trigger if exists trg_go_no_go_updated_at on go_no_go_decisions;
create trigger trg_go_no_go_updated_at
  before update on go_no_go_decisions
  for each row execute function app.set_updated_at();

-- Documentos de bases (pliegos), con referencia a almacenamiento externo y
-- texto extraído para análisis posterior.
create table if not exists tender_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  document_type text not null default 'other',
  storage_ref text not null,
  file_hash text,
  extracted_text text,
  page_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_tender_documents_org_tender on tender_documents (org_id, tender_id);

drop trigger if exists trg_tender_documents_updated_at on tender_documents;
create trigger trg_tender_documents_updated_at
  before update on tender_documents
  for each row execute function app.set_updated_at();

-- Requisitos extraídos de las bases (con trazabilidad de página/fuente).
create table if not exists requirement_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  document_id uuid references tender_documents (id) on delete set null,
  category text not null default 'general',
  description text not null,
  is_mandatory boolean not null default true,
  source_page integer,
  source_excerpt text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_requirement_items_org_tender on requirement_items (org_id, tender_id);

drop trigger if exists trg_requirement_items_updated_at on requirement_items;
create trigger trg_requirement_items_updated_at
  before update on requirement_items
  for each row execute function app.set_updated_at();

-- Checklist de cumplimiento documental (evidencia y estado por requisito).
create table if not exists compliance_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  requirement_id uuid references requirement_items (id) on delete set null,
  label text not null,
  status compliance_status not null default 'pending',
  evidence_ref text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_compliance_items_org_tender on compliance_items (org_id, tender_id);

drop trigger if exists trg_compliance_items_updated_at on compliance_items;
create trigger trg_compliance_items_updated_at
  before update on compliance_items
  for each row execute function app.set_updated_at();
