-- 0109_req112_worker_kyc_cross_tenant_reads.sql
-- REQ-112: el job nocturno de KYC negativo/fingerprint de interpósita
-- persona (`apps/worker`) corre como una corrida de PLATAFORMA (sin
-- organización activa) y necesita leer, de TODOS los tenants a la vez, las
-- señales de identidad que ya existían antes de esta ronda de cierre:
-- `organizations.name`, `company_profiles.tax_id`, `locations` (domicilio)
-- y `authorized_signatories` (representantes). Estas 4 tablas son
-- ANTERIORES a esta ronda (0002/0008/0011/0016) -- por convención de este
-- repo (ver 0019+ "fix_*", y 0028_worker_role.sql para el precedente
-- exacto de este mismo problema con `jobs`/`source_runs`) una migración ya
-- aplicada NUNCA se edita in place; se agrega una nueva que REDEFINE la
-- política existente añadiendo la condición adicional, sin quitar ninguna
-- de las que ya había.
--
-- Alcance deliberadamente mínimo: SOLO `select` (el worker nunca escribe
-- el perfil de una empresa), y solo estas 4 tablas -- exactamente las que
-- `packages/kyc` necesita para construir un `EntityFingerprintInput` por
-- organización (ver `apps/worker/src/handlers/kyc-screening.ts`).
--
-- NOTA DE CONSOLIDACIÓN (workflow de cierre, fusión de ~20 items en una
-- sola rama): 0103_req060_oic_module.sql (REQ-060, módulo comprador/OIC)
-- YA redefine `sel_organizations` en la misma ronda de cierre, añadiendo
-- `app.has_oic_role(...)` a la política. Como ambas migraciones hacen
-- `drop policy if exists` + `create policy` sobre el MISMO nombre de
-- política, la que se aplica DESPUÉS (esta, 0109 > 0103) determina el
-- estado final -- por eso aquí se conserva EXPLÍCITAMENTE también la
-- cláusula OIC de 0103, para no perderla silenciosamente. Si en el futuro
-- se toca de nuevo `sel_organizations`, replicar las 4 condiciones de abajo.

grant select on organizations to worker_role;
grant select on company_profiles to worker_role;
grant select on locations to worker_role;
grant select on authorized_signatories to worker_role;

drop policy if exists sel_organizations on organizations;
create policy sel_organizations on organizations
  for select using (
    current_user = 'worker_role'
    or app.is_superadmin()
    or app.has_role(id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[])
    or app.has_oic_role(id, '{director_oic,analista_oic,consulta_oic}'::oic_role[])
  );

drop policy if exists sel_company_profiles on company_profiles;
create policy sel_company_profiles on company_profiles
  for select using (
    current_user = 'worker_role'
    or app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists sel_locations on locations;
create policy sel_locations on locations
  for select using (
    current_user = 'worker_role'
    or app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists sel_authorized_signatories on authorized_signatories;
create policy sel_authorized_signatories on authorized_signatories
  for select using (
    current_user = 'worker_role'
    or app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );
