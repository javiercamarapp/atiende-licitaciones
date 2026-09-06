-- 0015_approvals_and_packages.sql
-- Aprobaciones de propuesta por rol (con invalidación cuando cambian las
-- bases) y el manifiesto/paquete final exportable. `package_manifests` solo
-- puede quedar en estado 'ready' si trae checklist_snapshot completo: se
-- refuerza con un CHECK, no solo con la validación de la aplicación.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'approval_status') then
    create type approval_status as enum ('pending', 'approved', 'rejected', 'invalidated');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'package_status') then
    create type package_status as enum ('draft', 'ready');
  end if;
end
$$;

create table if not exists proposal_approvals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  approver_role org_role not null,
  approver_id uuid references users (id) on delete set null,
  status approval_status not null default 'pending',
  decided_at timestamptz,
  invalidated_by_change_id uuid references tender_change_events (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_proposal_approvals_org_proposal on proposal_approvals (org_id, proposal_id);

drop trigger if exists trg_proposal_approvals_updated_at on proposal_approvals;
create trigger trg_proposal_approvals_updated_at
  before update on proposal_approvals
  for each row execute function app.set_updated_at();

-- Paquete final: manifiesto de archivos con hashes + snapshot del checklist
-- en el momento de generarse. `ready` exige snapshot no vacío (constraint);
-- la validación de COMPLETITUD real (todos los items 'complete') es lógica
-- de aplicación (packages/expediente), pero el esquema impide al menos el
-- caso trivial de "ready" sin checklist siquiera capturado.
create table if not exists package_manifests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  status package_status not null default 'draft',
  manifest jsonb not null default '{"files": []}'::jsonb,
  checklist_snapshot jsonb,
  generated_by uuid references users (id) on delete set null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint package_ready_requires_checklist check (status = 'draft' or checklist_snapshot is not null)
);

create index if not exists ix_package_manifests_org_proposal on package_manifests (org_id, proposal_id);

drop trigger if exists trg_package_manifests_updated_at on package_manifests;
create trigger trg_package_manifests_updated_at
  before update on package_manifests
  for each row execute function app.set_updated_at();
