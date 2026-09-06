-- 0006_proposals_pipeline.sql
-- Redacción trazable de propuestas, revisión, entrega (simulada, sin envío
-- externo real) y seguimiento post-adjudicación.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'proposal_status') then
    create type proposal_status as enum ('draft', 'in_review', 'approved', 'submitted', 'withdrawn');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'review_status') then
    create type review_status as enum ('pending', 'changes_requested', 'approved');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'submission_status') then
    create type submission_status as enum ('draft', 'ready', 'submitted', 'acknowledged', 'rejected');
  end if;
end
$$;

create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  title text not null,
  status proposal_status not null default 'draft',
  version integer not null default 1,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_proposals_org_tender on proposals (org_id, tender_id);

drop trigger if exists trg_proposals_updated_at on proposals;
create trigger trg_proposals_updated_at
  before update on proposals
  for each row execute function app.set_updated_at();

-- Cada sección lleva sus fuentes/citas y número de versión propio para
-- trazabilidad fina (qué requisito o documento sustenta cada párrafo).
create table if not exists proposal_sections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  section_key text not null,
  title text not null,
  content text not null default '',
  sources jsonb not null default '[]'::jsonb,
  version integer not null default 1,
  updated_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (proposal_id, section_key)
);

create index if not exists ix_proposal_sections_org_proposal on proposal_sections (org_id, proposal_id);

drop trigger if exists trg_proposal_sections_updated_at on proposal_sections;
create trigger trg_proposal_sections_updated_at
  before update on proposal_sections
  for each row execute function app.set_updated_at();

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  reviewer_id uuid references users (id) on delete set null,
  status review_status not null default 'pending',
  findings jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_reviews_org_proposal on reviews (org_id, proposal_id);

drop trigger if exists trg_reviews_updated_at on reviews;
create trigger trg_reviews_updated_at
  before update on reviews
  for each row execute function app.set_updated_at();

-- Entrega: modela el estado de envío sin realizar ningún envío externo real.
create table if not exists submissions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  status submission_status not null default 'draft',
  acknowledgement_ref text,
  submitted_by uuid references users (id) on delete set null,
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_submissions_org_proposal on submissions (org_id, proposal_id);

drop trigger if exists trg_submissions_updated_at on submissions;
create trigger trg_submissions_updated_at
  before update on submissions
  for each row execute function app.set_updated_at();

-- Seguimiento post-adjudicación: hitos, garantías, facturación.
create table if not exists post_award_followups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  kind text not null, -- 'hito' | 'garantia' | 'facturacion' | ...
  label text not null,
  due_date date,
  status text not null default 'pending',
  amount numeric(14, 2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_post_award_followups_org_tender on post_award_followups (org_id, tender_id);

drop trigger if exists trg_post_award_followups_updated_at on post_award_followups;
create trigger trg_post_award_followups_updated_at
  before update on post_award_followups
  for each row execute function app.set_updated_at();
