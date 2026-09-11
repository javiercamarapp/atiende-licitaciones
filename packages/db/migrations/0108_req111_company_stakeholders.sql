-- 0108_req111_company_stakeholders.sql
-- REQ-111 (docs/REQUISITOS.md): el fingerprint de entidad para detectar
-- interpósita persona requiere RFC + SOCIOS + representantes + domicilio.
-- `company_profiles.tax_id` (RFC), `locations` (domicilio) y
-- `authorized_signatories` (representantes/firmantes) ya existían (0011);
-- NINGUNA tabla de socios/accionistas existía en el repo antes de esta
-- migración -- se agrega aquí, siguiendo exactamente el mismo patrón que
-- el resto de subtablas de `company_profiles` (0011): org_id + RLS vía
-- `app.apply_org_rls` (0016), mismos roles de escritura que
-- `authorized_signatories`/`registrations` (owner/admin, por su
-- sensibilidad -- quién es dueño de la empresa es tan sensible como quién
-- puede firmar por ella).

create table if not exists company_stakeholders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  -- Texto libre (no enum cerrado), mismo criterio que `registrations.kind`
  -- (0011): "socio"/"accionista" son los valores esperados en la capa de
  -- aplicación, pero la figura societaria varía por tipo de sociedad
  -- (S.A. de C.V. tiene accionistas, S. de R.L. tiene socios, persona
  -- física con actividad empresarial no tiene ninguno) y no vale la pena
  -- acoplar el esquema a esa taxonomía.
  kind text not null,
  full_name text not null,
  rfc text,
  participation_pct numeric(5, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ix_company_stakeholders_org on company_stakeholders (org_id);

drop trigger if exists trg_company_stakeholders_updated_at on company_stakeholders;
create trigger trg_company_stakeholders_updated_at
  before update on company_stakeholders
  for each row execute function app.set_updated_at();

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  membership_admin_roles org_role[] := '{owner,admin}';
begin
  perform app.apply_org_rls('company_stakeholders', all_roles, membership_admin_roles);
end;
$$;

-- REQ-112: el job nocturno de KYC/fingerprint (`apps/worker`, rol
-- `worker_role` desde 0028) necesita leer los socios/accionistas de TODOS
-- los tenants para el fingerprint de interpósita persona -- nunca
-- escribirlos. Mismo patrón que `jobs`/`source_runs` en
-- `0028_worker_role.sql`: condición ADICIONAL sobre la política existente.
grant select on company_stakeholders to worker_role;

drop policy if exists sel_company_stakeholders on company_stakeholders;
create policy sel_company_stakeholders on company_stakeholders
  for select using (
    current_user = 'worker_role'
    or app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );
