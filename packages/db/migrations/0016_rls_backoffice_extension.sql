-- 0016_rls_backoffice_extension.sql
-- Activa RLS en todas las tablas nuevas de la ampliación de back office que
-- tienen org_id, reutilizando app.apply_org_rls (0007). `source_runs` queda
-- fuera (no tiene org_id; su RLS ya se definió en 0013 como "solo
-- superadmin").

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}'; -- viewer nunca escribe
  membership_admin_roles org_role[] := '{owner,admin}';
  decision_roles org_role[] := '{owner,admin,analyst}';
begin
  -- Perfil de empresa: cualquier rol de escritura puede mantenerlo al día,
  -- salvo firmantes/registros/documentos legales, que se restringen a
  -- owner/admin por su sensibilidad.
  perform app.apply_org_rls('company_profiles', all_roles, membership_admin_roles);
  perform app.apply_org_rls('capabilities', all_roles, write_roles);
  perform app.apply_org_rls('experience_records', all_roles, write_roles);
  perform app.apply_org_rls('products_services', all_roles, write_roles);
  perform app.apply_org_rls('locations', all_roles, write_roles);
  perform app.apply_org_rls('registrations', all_roles, membership_admin_roles);
  perform app.apply_org_rls('company_documents', all_roles, membership_admin_roles);
  perform app.apply_org_rls('authorized_signatories', all_roles, membership_admin_roles);
  perform app.apply_org_rls('restrictions', all_roles, membership_admin_roles);
  perform app.apply_org_rls('field_provenance', all_roles, write_roles);

  -- Versionado de convocatorias y eventos de cambio: mismo criterio que el
  -- resto del dominio de tenders (viewer solo lee).
  perform app.apply_org_rls('tender_versions', all_roles, write_roles);
  perform app.apply_org_rls('tender_change_events', all_roles, write_roles);

  -- Precios: el catálogo de tarifas se aprueba con criterio de decisión
  -- (mismo conjunto de roles que go/no-go); las líneas de una propuesta las
  -- redactan los roles de escritura habituales.
  perform app.apply_org_rls('approved_rates', all_roles, decision_roles);
  perform app.apply_org_rls('proposal_pricing_lines', all_roles, write_roles);

  -- Aprobaciones y paquete final: aprobar es una decisión (decision_roles);
  -- generar/editar el manifiesto lo hacen los roles de escritura.
  perform app.apply_org_rls('proposal_approvals', all_roles, decision_roles);
  perform app.apply_org_rls('package_manifests', all_roles, write_roles);
end;
$$;
