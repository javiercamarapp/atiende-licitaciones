-- 0003_system_tables.sql
-- audit_log, idempotency_keys, jobs (cola con reintentos) y rate_limits.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'job_status') then
    create type job_status as enum ('queued', 'running', 'succeeded', 'failed', 'dead');
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'idempotency_status') then
    create type idempotency_status as enum ('in_progress', 'completed', 'failed');
  end if;
end
$$;

-- audit_log: append-only, nunca se actualiza (ver políticas RLS en 0008).
create table if not exists audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  actor_id uuid references users (id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  request_id text,
  created_at timestamptz not null default now()
);

create index if not exists ix_audit_log_org_created on audit_log (org_id, created_at desc);
create index if not exists ix_audit_log_entity on audit_log (org_id, entity, entity_id);

-- idempotency_keys: una clave de idempotencia es única por organización.
-- Guarda el hash del cuerpo de la petición original para poder detectar un
-- reintento con un cuerpo distinto bajo la misma clave (422 en la API).
create table if not exists idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  key text not null,
  request_hash text not null,
  response jsonb,
  status_code integer,
  status idempotency_status not null default 'in_progress',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null,
  unique (org_id, key)
);

create index if not exists ix_idempotency_keys_expires on idempotency_keys (expires_at);

drop trigger if exists trg_idempotency_keys_updated_at on idempotency_keys;
create trigger trg_idempotency_keys_updated_at
  before update on idempotency_keys
  for each row execute function app.set_updated_at();

-- jobs: cola de trabajo con backoff exponencial y lock optimista/pesimista
-- vía SELECT ... FOR UPDATE SKIP LOCKED (ver test de concurrencia).
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations (id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status job_status not null default 'queued',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_jobs_claimable on jobs (status, next_run_at);
create index if not exists ix_jobs_org on jobs (org_id);

drop trigger if exists trg_jobs_updated_at on jobs;
create trigger trg_jobs_updated_at
  before update on jobs
  for each row execute function app.set_updated_at();

-- rate_limits: contador por organización/usuario/ventana temporal, usado como
-- respaldo/almacén persistente del limitador (además del limitador en memoria
-- de @fastify/rate-limit para la ronda 1).
create table if not exists rate_limits (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  subject text not null, -- p.ej. user_id o api_key id
  route text not null,
  window_start timestamptz not null,
  window_seconds integer not null,
  count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, subject, route, window_start)
);

create index if not exists ix_rate_limits_org on rate_limits (org_id);

drop trigger if exists trg_rate_limits_updated_at on rate_limits;
create trigger trg_rate_limits_updated_at
  before update on rate_limits
  for each row execute function app.set_updated_at();
