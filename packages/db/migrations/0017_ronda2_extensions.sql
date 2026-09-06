-- 0017_ronda2_extensions.sql
-- Ampliaciones de ronda 2 de apps/api sobre el esquema ya construido en
-- ronda 1 (0001-0016). Solo ADICIONES (columnas/tablas/funciones nuevas,
-- valores de enum nuevos): ninguna migración existente se edita.
--
-- Contenido:
--  1. refresh_tokens: revocación real de refresh tokens (logout / rotación).
--  2. app.accept_invitation: aceptar invitación pendiente (self-service).
--  3. approved_rates: permite que un rol de escritura (incl. `writer`)
--     PROPONGA una tarifa (INSERT); aprobar (UPDATE) sigue reservado a
--     decision_roles (owner/admin/analyst) — la aplicación restringe además
--     la acción específica de "aprobar" a owner/admin (ver apps/api).
--  4. agent_runs/tool_calls: columnas adicionales para que apps/api pueda
--     implementar RunStore/ToolCallStore/ToolCallStore de packages/agents
--     contra Postgres real, sin perder las columnas de ronda 1.
--  5. incidents: tabla mínima para el back office (E10).

-- ---------------------------------------------------------------------------
-- 1. refresh_tokens
-- ---------------------------------------------------------------------------
create table if not exists refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists ix_refresh_tokens_user on refresh_tokens (user_id);

-- RLS habilitada SIN políticas a propósito: nadie accede a esta tabla
-- directamente vía app_role (ni siquiera su propio dueño); todo acceso pasa
-- por las funciones SECURITY DEFINER de abajo, que validan la operación
-- exacta permitida (crear al login, buscar/rotar al refresh, revocar en
-- logout). Mismo patrón que app.find_user_by_email en 0010.
alter table refresh_tokens enable row level security;

create or replace function app.create_refresh_token(
  p_id uuid, p_user_id uuid, p_token_hash text, p_expires_at timestamptz
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into refresh_tokens (id, user_id, token_hash, expires_at)
  values (p_id, p_user_id, p_token_hash, p_expires_at)
$$;

create or replace function app.find_refresh_token(p_token_hash text)
returns table (id uuid, user_id uuid, expires_at timestamptz, revoked_at timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id, user_id, expires_at, revoked_at
  from refresh_tokens
  where token_hash = p_token_hash
  limit 1
$$;

create or replace function app.revoke_refresh_token(p_token_hash text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update refresh_tokens set revoked_at = now()
  where token_hash = p_token_hash and revoked_at is null
$$;

create or replace function app.revoke_all_refresh_tokens(p_user_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update refresh_tokens set revoked_at = now()
  where user_id = p_user_id and revoked_at is null
$$;

-- ---------------------------------------------------------------------------
-- 2. Aceptar invitación
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: el usuario invitado todavía no es miembro de la
-- organización (o está aceptando su primer/rol distinto), así que la
-- política estándar ins_memberships (owner/admin, o bootstrap sin
-- membresías) no aplicaría. Esta función valida explícitamente: token
-- coincide, invitación pendiente, no expirada, y el email de la invitación
-- coincide con el email del usuario autenticado -- solo entonces inserta la
-- membresía, bypasseando la política general de forma controlada y auditada
-- por la propia lógica de la función (no un bypass general de RLS).
-- Nota: los parámetros de RETURNS TABLE se convierten en variables plpgsql
-- implícitas (out_org_id/out_role) DELIBERADAMENTE nombradas distinto de
-- cualquier columna real ("org_id"/"role" a secas) para evitar ambigüedad
-- con `insert into memberships (org_id, ...) ... on conflict (org_id, ...)`
-- más abajo (Postgres resolvía "org_id" contra la variable de salida, no la
-- columna, y fallaba con "column reference org_id is ambiguous").
create or replace function app.accept_invitation(p_token_hash text, p_user_id uuid)
returns table (out_org_id uuid, out_role org_role)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invitation invitations%rowtype;
  v_user_email text;
begin
  select * into v_invitation from invitations where token_hash = p_token_hash for update;
  if not found then
    raise exception 'invitation_not_found';
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'invitation_not_pending';
  end if;

  -- No se marca `expired` aquí: lanzar una excepción revierte toda la
  -- transacción de esta llamada (plpgsql no tiene autonomous transactions
  -- sin extensiones), así que cualquier UPDATE previo al RAISE también se
  -- revertiría. La transición a `expired` la hace la capa de aplicación (lectura
  -- perezosa comparando `expires_at` contra `now()`) o un job de limpieza aparte.
  if v_invitation.expires_at < now() then
    raise exception 'invitation_expired';
  end if;

  select lower(u.email) into v_user_email from users u where u.id = p_user_id;
  if v_user_email is null or v_user_email <> lower(v_invitation.email) then
    raise exception 'invitation_email_mismatch';
  end if;

  insert into memberships (org_id, user_id, role)
  values (v_invitation.org_id, p_user_id, v_invitation.role)
  on conflict (org_id, user_id) do update set role = excluded.role, status = 'active';

  update invitations set status = 'accepted' where id = v_invitation.id;

  return query select v_invitation.org_id, v_invitation.role;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. approved_rates: separar "proponer" (writer) de "aprobar" (decision_roles,
--    restringido además a owner/admin en la aplicación).
-- ---------------------------------------------------------------------------
drop policy if exists ins_approved_rates on approved_rates;
create policy ins_approved_rates on approved_rates
  for insert with check (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer}'::org_role[]))
  );

-- ---------------------------------------------------------------------------
-- 4. Persistencia de packages/agents (RunStore/ToolCallStore) sobre
--    agent_runs/tool_calls ya existentes.
-- ---------------------------------------------------------------------------
alter table agent_runs add column if not exists actor_id uuid references users (id) on delete set null;
alter table agent_runs add column if not exists actor_role org_role;
alter table agent_runs add column if not exists total_steps integer not null default 0;
alter table agent_runs add column if not exists completed_steps integer not null default 0;
alter table agent_runs add column if not exists pending_step_index integer;
alter table agent_runs add column if not exists correlation_id text;
alter table agent_runs add column if not exists estimated_cost_usd numeric(12, 4) not null default 0;
alter table agent_runs add column if not exists error text;

create index if not exists ix_agent_runs_correlation on agent_runs (org_id, correlation_id);

alter table tool_calls add column if not exists step_index integer not null default 0;
alter table tool_calls add column if not exists actor_id_trace uuid references users (id) on delete set null;
alter table tool_calls add column if not exists actor_role org_role;
-- `status`: estado de ejecución del ToolCallTrace de packages/agents (ok,
-- error, denied, pending_approval, blocked_guardrail, cancelled,
-- pending_no_fabrication, invalidated) -- concepto DISTINTO de
-- `authorization_status` (auto/pending/approved/denied, ronda 1: workflow de
-- aprobación humana de una llamada pendiente). Se guarda como texto libre a
-- propósito (el enum de packages/agents es responsabilidad de esa capa, no
-- de packages/db) en vez de crear un nuevo tipo enum que duplicaría esa
-- lista y tendría que mantenerse sincronizada manualmente.
alter table tool_calls add column if not exists status text;
alter table tool_calls add column if not exists started_at timestamptz not null default now();
alter table tool_calls add column if not exists finished_at timestamptz;
alter table tool_calls add column if not exists input_hash text;
alter table tool_calls add column if not exists output_hash text;
alter table tool_calls add column if not exists attempts integer not null default 1;
alter table tool_calls add column if not exists estimated_tokens integer not null default 0;
alter table tool_calls add column if not exists estimated_cost_usd numeric(12, 4) not null default 0;
alter table tool_calls add column if not exists authorization_reason text;
alter table tool_calls add column if not exists error text;
alter table tool_calls add column if not exists correlation_id text;
alter table tool_calls add column if not exists missing_sourced_fields text[];

create index if not exists ix_tool_calls_correlation on tool_calls (org_id, correlation_id);

-- Nuevos valores del ciclo de vida completo de AgentRunStatus (packages/agents).
-- Solo se AGREGAN valores; los existentes (running/succeeded/failed/cancelled)
-- se conservan para no romper filas ya escritas. Postgres prohíbe usar un
-- valor de enum recién agregado dentro de la MISMA transacción en la que se
-- agrega: por eso esta migración únicamente declara los valores y no los usa
-- en ningún DEFAULT/INSERT/UPDATE de este mismo archivo (el runtime de la
-- API los usa en transacciones posteriores, ya con el archivo aplicado).
alter type agent_run_status add value if not exists 'in_progress';
alter type agent_run_status add value if not exists 'needs_approval';
alter type agent_run_status add value if not exists 'completed';
alter type agent_run_status add value if not exists 'denied';
alter type agent_run_status add value if not exists 'blocked';
alter type agent_run_status add value if not exists 'timed_out';
alter type agent_run_status add value if not exists 'needs_data';
alter type agent_run_status add value if not exists 'invalidated';

-- ---------------------------------------------------------------------------
-- 5. incidents: tabla mínima para el back office (E10/REQ-170).
-- ---------------------------------------------------------------------------
create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organizations (id) on delete cascade,
  title text not null,
  description text,
  severity text not null default 'low',
  status text not null default 'open',
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists ix_incidents_org on incidents (org_id);

drop trigger if exists trg_incidents_updated_at on incidents;
create trigger trg_incidents_updated_at
  before update on incidents
  for each row execute function app.set_updated_at();

alter table incidents enable row level security;

drop policy if exists sel_incidents on incidents;
create policy sel_incidents on incidents
  for select using (
    app.is_superadmin()
    or (org_id is not null and org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists ins_incidents on incidents;
create policy ins_incidents on incidents
  for insert with check (
    app.is_superadmin()
    or (org_id is not null and org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer}'::org_role[]))
  );

-- Resolver/editar un incidente es una acción de back office (superadmin);
-- una organización puede reportarlo (INSERT arriba) pero no reescribirlo.
drop policy if exists upd_incidents on incidents;
create policy upd_incidents on incidents
  for update using (app.is_superadmin())
  with check (app.is_superadmin());
