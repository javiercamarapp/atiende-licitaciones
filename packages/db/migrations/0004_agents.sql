-- 0004_agents.sql
-- agent_runs y tool_calls: trazabilidad de ejecuciones de agentes de IA y las
-- llamadas a herramientas que requieren autorización humana (human-in-the-loop).

do $$
begin
  if not exists (select 1 from pg_type where typname = 'agent_run_status') then
    create type agent_run_status as enum ('running', 'succeeded', 'failed', 'cancelled');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'tool_authorization_status') then
    create type tool_authorization_status as enum ('auto', 'pending', 'approved', 'denied');
  end if;
end
$$;

create table if not exists agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  agent_name text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb,
  status agent_run_status not null default 'running',
  started_by uuid references users (id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_agent_runs_org on agent_runs (org_id, created_at desc);

drop trigger if exists trg_agent_runs_updated_at on agent_runs;
create trigger trg_agent_runs_updated_at
  before update on agent_runs
  for each row execute function app.set_updated_at();

create table if not exists tool_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  agent_run_id uuid not null references agent_runs (id) on delete cascade,
  tool_name text not null,
  arguments jsonb not null default '{}'::jsonb,
  result jsonb,
  authorization_status tool_authorization_status not null default 'pending',
  approved_by uuid references users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_tool_calls_org on tool_calls (org_id, created_at desc);
create index if not exists ix_tool_calls_run on tool_calls (agent_run_id);
create index if not exists ix_tool_calls_auth_status on tool_calls (org_id, authorization_status);

drop trigger if exists trg_tool_calls_updated_at on tool_calls;
create trigger trg_tool_calls_updated_at
  before update on tool_calls
  for each row execute function app.set_updated_at();
