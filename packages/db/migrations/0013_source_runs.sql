-- 0013_source_runs.sql
-- Ejecuciones de ingesta por fuente oficial (CompraNet, sucesor, OCDS, etc.).
--
-- DECISIÓN DE DISEÑO: esta tabla es de PLATAFORMA, no por organización. La
-- ingesta de una fuente pública ocurre una sola vez y se reutiliza para el
-- matching de TODAS las organizaciones (ver tender_matches, que sí es por
-- org). Por eso `source_runs` no tiene org_id y su RLS es "solo back office"
-- (superadmin), no aislamiento multi-tenant -- no aplica el patrón
-- app.apply_org_rls de 0007/0008. Estados explícitos: nunca se interpreta
-- silencio como "cero oportunidades" (ver estado 'down'/'captcha'/etc.).
do $$
begin
  if not exists (select 1 from pg_type where typname = 'source_run_status') then
    create type source_run_status as enum (
      'ok', 'failed', 'captcha', 'interface_changed', 'permission_missing', 'down'
    );
  end if;
end
$$;

create table if not exists source_runs (
  id uuid primary key default gen_random_uuid(),
  source_id text not null,
  status source_run_status not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  attempts integer not null default 1,
  last_success_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  coverage jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ix_source_runs_source on source_runs (source_id, started_at desc);
create index if not exists ix_source_runs_status on source_runs (status);

alter table source_runs enable row level security;

drop policy if exists sel_source_runs on source_runs;
create policy sel_source_runs on source_runs for select using (app.is_superadmin());

drop policy if exists ins_source_runs on source_runs;
create policy ins_source_runs on source_runs for insert with check (app.is_superadmin());

drop policy if exists upd_source_runs on source_runs;
create policy upd_source_runs on source_runs for update using (app.is_superadmin()) with check (app.is_superadmin());
