-- 0008_rls_policies.sql
-- Activa RLS en todas las tablas con org_id (y en organizations/users/
-- platform_admins con reglas propias) usando las funciones de 0007.
--
-- IMPORTANTE (documentado también en README): NO se usa
-- `FORCE ROW LEVEL SECURITY`. app_role nunca es el propietario de las tablas
-- ni superusuario, así que RLS ya se le aplica sin necesidad de FORCE; dejar
-- las tablas sin FORCE es lo que permite que las funciones SECURITY DEFINER
-- de 0007 (propiedad del rol que ejecuta las migraciones) puedan leer
-- memberships/platform_admins sin recursión al resolver has_role()/
-- is_superadmin(). Este es el mismo patrón usado en el proyecto de
-- referencia auditado (funciones de seguridad con bypass de propietario).

-- ---------------------------------------------------------------------------
-- organizations: no tiene columna org_id (su propio id lo es).
-- ---------------------------------------------------------------------------
alter table organizations enable row level security;

drop policy if exists sel_organizations on organizations;
create policy sel_organizations on organizations
  for select using (
    app.is_superadmin()
    or app.has_role(id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[])
  );

-- Cualquier usuario autenticado (con current_user_id resuelto) puede crear una
-- organización nueva; la membresía "owner" se inserta en la misma transacción
-- desde la API. No puede depender de has_role porque el usuario aún no es
-- miembro de la organización que está creando.
drop policy if exists ins_organizations on organizations;
create policy ins_organizations on organizations
  for insert with check (app.is_superadmin() or app.current_user_id() is not null);

drop policy if exists upd_organizations on organizations;
create policy upd_organizations on organizations
  for update using (
    app.is_superadmin() or app.has_role(id, '{owner,admin}'::org_role[])
  )
  with check (
    app.is_superadmin() or app.has_role(id, '{owner,admin}'::org_role[])
  );

drop policy if exists del_organizations on organizations;
create policy del_organizations on organizations
  for delete using (app.is_superadmin() or app.has_role(id, '{owner}'::org_role[]));

-- ---------------------------------------------------------------------------
-- users: identidad global; cada usuario solo ve/edita su propia fila.
-- ---------------------------------------------------------------------------
alter table users enable row level security;

drop policy if exists sel_users on users;
create policy sel_users on users
  for select using (app.is_superadmin() or id = app.current_user_id());

-- El registro es una acción pública (no hay current_user_id todavía).
drop policy if exists ins_users on users;
create policy ins_users on users
  for insert with check (true);

drop policy if exists upd_users on users;
create policy upd_users on users
  for update using (app.is_superadmin() or id = app.current_user_id())
  with check (app.is_superadmin() or id = app.current_user_id());

drop policy if exists del_users on users;
create policy del_users on users
  for delete using (app.is_superadmin());

-- ---------------------------------------------------------------------------
-- platform_admins: solo superadmins gestionan la tabla de superadmins.
-- ---------------------------------------------------------------------------
alter table platform_admins enable row level security;

drop policy if exists sel_platform_admins on platform_admins;
create policy sel_platform_admins on platform_admins
  for select using (app.is_superadmin());

drop policy if exists ins_platform_admins on platform_admins;
create policy ins_platform_admins on platform_admins
  for insert with check (app.is_superadmin());

drop policy if exists del_platform_admins on platform_admins;
create policy del_platform_admins on platform_admins
  for delete using (app.is_superadmin());

-- ---------------------------------------------------------------------------
-- audit_log: append-only. Solo SELECT/INSERT; nadie (ni superadmin) puede
-- actualizar o borrar vía RLS -- integridad de auditoría.
-- ---------------------------------------------------------------------------
alter table audit_log enable row level security;

drop policy if exists sel_audit_log on audit_log;
create policy sel_audit_log on audit_log
  for select using (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists ins_audit_log on audit_log;
create policy ins_audit_log on audit_log
  for insert with check (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

-- ---------------------------------------------------------------------------
-- Resto de tablas con org_id: patrón estándar vía app.apply_org_rls.
-- ---------------------------------------------------------------------------
do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}'; -- viewer nunca escribe
  membership_admin_roles org_role[] := '{owner,admin}';
  decision_roles org_role[] := '{owner,admin,analyst}'; -- writer NO decide go/no-go
begin
  perform app.apply_org_rls('invitations', membership_admin_roles, membership_admin_roles);
  perform app.apply_org_rls('api_keys', membership_admin_roles, membership_admin_roles);

  perform app.apply_org_rls('idempotency_keys', all_roles, all_roles);
  perform app.apply_org_rls('jobs', all_roles, all_roles);
  perform app.apply_org_rls('rate_limits', all_roles, all_roles);

  perform app.apply_org_rls('agent_runs', all_roles, write_roles);
  perform app.apply_org_rls('tool_calls', all_roles, write_roles);

  perform app.apply_org_rls('tenders', all_roles, write_roles);
  perform app.apply_org_rls('tender_matches', all_roles, write_roles);
  perform app.apply_org_rls('go_no_go_decisions', all_roles, decision_roles);
  perform app.apply_org_rls('tender_documents', all_roles, write_roles);
  perform app.apply_org_rls('requirement_items', all_roles, write_roles);
  perform app.apply_org_rls('compliance_items', all_roles, write_roles);

  perform app.apply_org_rls('proposals', all_roles, write_roles);
  perform app.apply_org_rls('proposal_sections', all_roles, write_roles);
  perform app.apply_org_rls('reviews', all_roles, write_roles);
  perform app.apply_org_rls('submissions', all_roles, write_roles);
  perform app.apply_org_rls('post_award_followups', all_roles, write_roles);
end;
$$;

-- ---------------------------------------------------------------------------
-- memberships: patrón estándar + excepción de "bootstrap". Cuando alguien
-- crea una organización nueva (ins_organizations, arriba) todavía no es
-- miembro de ella, así que la política estándar (has_role) le impediría
-- insertarse a sí mismo como primer owner. Se permite el INSERT sin
-- comprobar rol únicamente cuando la organización TODAVÍA no tiene ninguna
-- membresía (bootstrap real de una org recién creada); en cualquier otro
-- caso (org ya poblada) sigue exigiéndose owner/admin, igual que para
-- invitar o cambiar el rol de alguien.
-- ---------------------------------------------------------------------------
alter table memberships enable row level security;

drop policy if exists sel_memberships on memberships;
create policy sel_memberships on memberships
  for select using (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[]))
  );

drop policy if exists ins_memberships on memberships;
create policy ins_memberships on memberships
  for insert with check (
    app.is_superadmin()
    or (
      org_id = app.current_org_id()
      and (
        app.has_role(org_id, '{owner,admin}'::org_role[])
        or app.org_has_no_memberships(org_id)
      )
    )
  );

drop policy if exists upd_memberships on memberships;
create policy upd_memberships on memberships
  for update using (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin}'::org_role[]))
  )
  with check (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin}'::org_role[]))
  );

drop policy if exists del_memberships on memberships;
create policy del_memberships on memberships
  for delete using (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin}'::org_role[]))
  );
