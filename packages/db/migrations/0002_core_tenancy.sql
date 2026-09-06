-- 0002_core_tenancy.sql
-- Identidades globales, organizaciones (tenants), membresías, invitaciones,
-- api_keys y tabla de superadmins de back office.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'org_role') then
    create type org_role as enum ('owner', 'admin', 'analyst', 'writer', 'reviewer', 'viewer');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'membership_status') then
    create type membership_status as enum ('active', 'suspended');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'invitation_status') then
    create type invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');
  end if;
end
$$;

create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_organizations_updated_at on organizations;
create trigger trg_organizations_updated_at
  before update on organizations
  for each row execute function app.set_updated_at();

-- Identidad global de usuario (no pertenece a un tenant; las membresías
-- vinculan usuario <-> organización). Se evita la extensión `citext` (no
-- disponible por defecto en PGlite) y se normaliza el email en minúsculas
-- en la capa de aplicación; el índice único usa lower(email) como defensa
-- adicional en la base de datos.
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  password_hash text not null,
  full_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists ux_users_email_lower on users (lower(email));

drop trigger if exists trg_users_updated_at on users;
create trigger trg_users_updated_at
  before update on users
  for each row execute function app.set_updated_at();

-- Membresía: vincula un usuario a una organización con un rol único.
create table if not exists memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role org_role not null,
  status membership_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create index if not exists ix_memberships_org on memberships (org_id);
create index if not exists ix_memberships_user on memberships (user_id);

drop trigger if exists trg_memberships_updated_at on memberships;
create trigger trg_memberships_updated_at
  before update on memberships
  for each row execute function app.set_updated_at();

-- Invitaciones pendientes de aceptar (por email, no requiere que el usuario exista aún).
create table if not exists invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  email text not null,
  role org_role not null,
  status invitation_status not null default 'pending',
  token_hash text not null,
  invited_by uuid references users (id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, email, status)
);

create index if not exists ix_invitations_org on invitations (org_id);

drop trigger if exists trg_invitations_updated_at on invitations;
create trigger trg_invitations_updated_at
  before update on invitations
  for each row execute function app.set_updated_at();

-- Claves de API por organización (solo se guarda el hash, nunca el secreto).
create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  name text not null,
  key_hash text not null unique,
  key_prefix text not null,
  created_by uuid references users (id) on delete set null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_api_keys_org on api_keys (org_id);

drop trigger if exists trg_api_keys_updated_at on api_keys;
create trigger trg_api_keys_updated_at
  before update on api_keys
  for each row execute function app.set_updated_at();

-- Superadmins de back office (fuera del modelo de organizaciones).
create table if not exists platform_admins (
  user_id uuid primary key references users (id) on delete cascade,
  granted_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now()
);
