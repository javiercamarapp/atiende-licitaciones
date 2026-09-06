-- 0011_company_profile.sql
-- Perfil de empresa por organización: capacidades, experiencia verificable,
-- productos/servicios, ubicaciones, registros (RFC/padrones), documentos de
-- empresa, firmantes autorizados y restricciones. Todo con org_id + RLS
-- (aplicada en 0016_rls_backoffice_extension.sql).
--
-- Procedencia por campo: `field_provenance` registra, para cualquier
-- (entidad, fila, campo) de negocio, quién lo capturó/actualizó y de dónde
-- viene el dato (evita que un dato "se sepa" sin saber su origen). Se
-- referencia por (entity, entity_id) en vez de FK física porque cubre
-- cualquier tabla de dominio, presente o futura.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'document_lifecycle_status') then
    create type document_lifecycle_status as enum ('valid', 'expiring_soon', 'expired', 'pending_verification');
  end if;
end
$$;

create table if not exists company_profiles (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references organizations (id) on delete cascade,
  legal_name text not null,
  trade_name text,
  tax_id text,
  description text,
  sector text,
  founded_year integer,
  employee_count integer,
  annual_revenue numeric(14, 2),
  website text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_company_profiles_updated_at on company_profiles;
create trigger trg_company_profiles_updated_at
  before update on company_profiles
  for each row execute function app.set_updated_at();

create table if not exists capabilities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  category text,
  description text,
  is_verified boolean not null default false,
  evidence_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_capabilities_org on capabilities (org_id);

drop trigger if exists trg_capabilities_updated_at on capabilities;
create trigger trg_capabilities_updated_at
  before update on capabilities
  for each row execute function app.set_updated_at();

-- Experiencia verificable: cada registro debe poder respaldarse con
-- evidence_ref; is_verified separa "declarado" de "confirmado".
create table if not exists experience_records (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  title text not null,
  client_name text,
  description text,
  contract_value numeric(14, 2),
  currency text default 'MXN',
  start_date date,
  end_date date,
  is_verified boolean not null default false,
  evidence_ref text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_experience_records_org on experience_records (org_id);

drop trigger if exists trg_experience_records_updated_at on experience_records;
create trigger trg_experience_records_updated_at
  before update on experience_records
  for each row execute function app.set_updated_at();

create table if not exists products_services (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  category text,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_products_services_org on products_services (org_id);

drop trigger if exists trg_products_services_updated_at on products_services;
create trigger trg_products_services_updated_at
  before update on products_services
  for each row execute function app.set_updated_at();

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  label text not null,
  address_line text,
  city text,
  state text,
  country text,
  postal_code text,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_locations_org on locations (org_id);

drop trigger if exists trg_locations_updated_at on locations;
create trigger trg_locations_updated_at
  before update on locations
  for each row execute function app.set_updated_at();

-- Registros genéricos (RFC, padrón de proveedores, licencias, etc.). `kind`
-- es texto libre para no acoplarse a la jurisdicción; el significado exacto
-- vive en la capa de aplicación.
create table if not exists registrations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  kind text not null,
  value text not null,
  issuing_authority text,
  valid_from date,
  valid_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_registrations_org on registrations (org_id);

drop trigger if exists trg_registrations_updated_at on registrations;
create trigger trg_registrations_updated_at
  before update on registrations
  for each row execute function app.set_updated_at();

create table if not exists company_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  document_type text not null,
  storage_ref text not null,
  file_hash text,
  valid_from date,
  valid_until date,
  status document_lifecycle_status not null default 'pending_verification',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_company_documents_org on company_documents (org_id);
create index if not exists ix_company_documents_expiry on company_documents (org_id, valid_until);

drop trigger if exists trg_company_documents_updated_at on company_documents;
create trigger trg_company_documents_updated_at
  before update on company_documents
  for each row execute function app.set_updated_at();

create table if not exists authorized_signatories (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  full_name text not null,
  role_title text,
  id_document_ref text,
  valid_from date,
  valid_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_authorized_signatories_org on authorized_signatories (org_id);

drop trigger if exists trg_authorized_signatories_updated_at on authorized_signatories;
create trigger trg_authorized_signatories_updated_at
  before update on authorized_signatories
  for each row execute function app.set_updated_at();

-- Restricciones/impedimentos declarados (p.ej. conflicto de interés, giro no
-- permitido, sanciones) que el matching y el go/no-go deben considerar.
create table if not exists restrictions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  kind text not null,
  description text,
  valid_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_restrictions_org on restrictions (org_id);

drop trigger if exists trg_restrictions_updated_at on restrictions;
create trigger trg_restrictions_updated_at
  before update on restrictions
  for each row execute function app.set_updated_at();

-- Procedencia por campo: un registro por (org, entidad, fila, campo); se
-- reemplaza (upsert) cada vez que ese campo se vuelve a capturar/actualizar.
create table if not exists field_provenance (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  entity text not null,
  entity_id text not null,
  field text not null,
  owner_user_id uuid references users (id) on delete set null,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, entity, entity_id, field)
);

create index if not exists ix_field_provenance_org_entity on field_provenance (org_id, entity, entity_id);
