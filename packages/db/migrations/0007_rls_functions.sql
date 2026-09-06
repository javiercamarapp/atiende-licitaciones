-- 0007_rls_functions.sql
-- Funciones auxiliares para las políticas RLS de 0008.
--
-- Todas son SECURITY DEFINER y fijan search_path explícito (mismo patrón que
-- el proyecto de referencia auditado: evita "search path hijacking" y evita
-- recursión de RLS al leer memberships/platform_admins, porque se ejecutan
-- con los privilegios del propietario de la función (el rol que corre las
-- migraciones), que NO tiene FORCE ROW LEVEL SECURITY aplicado sobre esas
-- tablas (ver comentario en 0008_rls_policies.sql).

create or replace function app.current_org_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_org_id', true), '')::uuid
$$;

create or replace function app.current_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('app.current_user_id', true), '')::uuid
$$;

create or replace function app.has_role(p_org_id uuid, p_roles org_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from memberships m
    where m.org_id = p_org_id
      and m.user_id = app.current_user_id()
      and m.status = 'active'
      and m.role = any(p_roles)
  )
$$;

create or replace function app.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from platform_admins pa
    where pa.user_id = app.current_user_id()
  )
$$;

-- Usada SOLO por la política de INSERT de memberships (bootstrap: el creador
-- de una organización nueva se auto-asigna como primer owner antes de tener
-- membresía). Debe ser SECURITY DEFINER: si se evaluara con los privilegios
-- de app_role, la propia política de SELECT de memberships ocultaría las
-- filas existentes al actor (que todavía no es miembro) y "no exists"
-- daría siempre true, incluso para una organización ya poblada -> agujero
-- de seguridad. Con SECURITY DEFINER se ve el estado real de la tabla.
create or replace function app.org_has_no_memberships(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (select 1 from memberships m where m.org_id = p_org_id)
$$;

-- Aplica el patrón estándar de aislamiento multi-tenant a una tabla que tiene
-- columna org_id: SELECT visible para roles de lectura de esa org (o
-- superadmin); INSERT/UPDATE/DELETE solo para roles de escritura de esa org
-- (o superadmin). Se llama una vez por tabla desde 0008_rls_policies.sql.
create or replace function app.apply_org_rls(
  p_table regclass,
  p_read_roles org_role[],
  p_write_roles org_role[]
)
returns void
language plpgsql
as $$
declare
  v_table text := p_table::text;
  v_name text := replace(v_table, '.', '_');
begin
  execute format('alter table %s enable row level security', p_table);

  execute format('drop policy if exists sel_%s on %s', v_name, p_table);
  execute format(
    'create policy sel_%s on %s for select using (app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, %L::org_role[])))',
    v_name, p_table, p_read_roles
  );

  execute format('drop policy if exists ins_%s on %s', v_name, p_table);
  execute format(
    'create policy ins_%s on %s for insert with check (app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, %L::org_role[])))',
    v_name, p_table, p_write_roles
  );

  execute format('drop policy if exists upd_%s on %s', v_name, p_table);
  execute format(
    'create policy upd_%s on %s for update using (app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, %L::org_role[]))) with check (app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, %L::org_role[])))',
    v_name, p_table, p_write_roles, p_write_roles
  );

  execute format('drop policy if exists del_%s on %s', v_name, p_table);
  execute format(
    'create policy del_%s on %s for delete using (app.is_superadmin() or (org_id = app.current_org_id() and app.has_role(org_id, %L::org_role[])))',
    v_name, p_table, p_write_roles
  );
end;
$$;
