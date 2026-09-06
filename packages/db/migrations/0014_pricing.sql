-- 0014_pricing.sql
-- Catálogo de precios/tarifas aprobadas por organización. Las propuestas
-- económicas SOLO pueden referenciar una tarifa de este catálogo (FK NOT
-- NULL en proposal_pricing_lines): no hay forma de insertar una línea de
-- precio que no apunte a una tarifa ya aprobada -- "no inventar precios" se
-- refuerza a nivel de esquema, no solo de aplicación.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'rate_status') then
    create type rate_status as enum ('draft', 'approved', 'archived');
  end if;
end
$$;

create table if not exists approved_rates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  item_code text not null,
  description text not null,
  unit text not null default 'unidad',
  unit_price numeric(14, 2) not null,
  currency text not null default 'MXN',
  status rate_status not null default 'draft',
  approved_by uuid references users (id) on delete set null,
  approved_at timestamptz,
  valid_from date,
  valid_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, item_code)
);

create index if not exists ix_approved_rates_org on approved_rates (org_id, status);

drop trigger if exists trg_approved_rates_updated_at on approved_rates;
create trigger trg_approved_rates_updated_at
  before update on approved_rates
  for each row execute function app.set_updated_at();

-- Línea de precio de una propuesta económica: FK NOT NULL a approved_rates,
-- y CHECK de que la tarifa esté aprobada se refuerza con un trigger (una
-- FK no puede expresar "y además status='approved'").
create table if not exists proposal_pricing_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  approved_rate_id uuid not null references approved_rates (id) on delete restrict,
  quantity numeric(14, 4) not null default 1,
  unit_price_snapshot numeric(14, 2) not null,
  line_total numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_proposal_pricing_lines_org_proposal on proposal_pricing_lines (org_id, proposal_id);

drop trigger if exists trg_proposal_pricing_lines_updated_at on proposal_pricing_lines;
create trigger trg_proposal_pricing_lines_updated_at
  before update on proposal_pricing_lines
  for each row execute function app.set_updated_at();

create or replace function app.enforce_approved_rate()
returns trigger
language plpgsql
as $$
declare
  v_status rate_status;
  v_org uuid;
begin
  select status, org_id into v_status, v_org from approved_rates where id = new.approved_rate_id;
  if v_status is null then
    raise exception 'approved_rate_id % no existe', new.approved_rate_id;
  end if;
  if v_status <> 'approved' then
    raise exception 'La tarifa % no está aprobada (status=%): no puede usarse en una propuesta económica', new.approved_rate_id, v_status;
  end if;
  if v_org <> new.org_id then
    raise exception 'La tarifa % pertenece a otra organización', new.approved_rate_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_approved_rate on proposal_pricing_lines;
create trigger trg_enforce_approved_rate
  before insert or update on proposal_pricing_lines
  for each row execute function app.enforce_approved_rate();
