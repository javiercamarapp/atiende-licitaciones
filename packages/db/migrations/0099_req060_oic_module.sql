-- 0099_req060_oic_module.sql
-- REQ-060: "Separación estricta de datos por tenant para producto de lado
-- comprador (OIC/contralorías): nunca exponer información privada de
-- proveedores propios" (docs/REQUISITOS.md §10; L09 §5.4/§8 hallazgo 49).
--
-- CONTEXTO: hasta esta migración, TODA la plataforma asume un único tipo de
-- tenant -- una empresa proveedora que licita. Este requisito pide un
-- SEGUNDO producto, para un tipo de cliente distinto (un Órgano Interno de
-- Control / contraloría que vigila procedimientos de contratación), con la
-- propiedad de que ningún actor de ese lado pueda ver jamás datos privados
-- de un proveedor (propuestas, bóveda documental, precios, membresías...).
--
-- DECISIÓN DE DISEÑO (aislamiento por CONSTRUCCIÓN, no solo por política):
--   1. `organizations.kind` distingue 'proveedor' (todo lo existente, valor
--      por defecto -- ninguna fila ni prueba existente cambia de
--      comportamiento) de 'comprador' (OIC/contraloría, nuevo).
--   2. Los roles del lado comprador viven en un enum y una tabla PROPIOS
--      (`oic_role` / `oic_memberships`), separados de `org_role` /
--      `memberships` del lado proveedor -- no una extensión del mismo
--      enum. "Su propio aislamiento de roles" (encargo REQ-060) se lee
--      aquí en sentido literal: no comparten ni el catálogo de roles ni la
--      tabla de membresías.
--   3. Un trigger en CADA tabla de membresías impide que una organización
--      'comprador' tenga una fila en `memberships` (rol de proveedor) y que
--      una organización 'proveedor' tenga una fila en `oic_memberships`
--      (rol de comprador). Esto es lo que hace el aislamiento estructural
--      y no solo convencional: como ningún usuario del lado comprador
--      puede tener NUNCA una fila en `memberships`, `app.has_role(...)`
--      (la función que protege TODAS las tablas privadas de proveedores,
--      0007/0008) siempre devuelve `false` para él, sin importar qué
--      `org_id` intente fijar como organización activa. La prueba de
--      aislamiento de REQ-060 (packages/db/test/req060-oic-isolation.test.ts)
--      verifica esto de forma adversarial contra TODAS las tablas de
--      dominio del proveedor (reutiliza `DOMAIN_TABLES` de
--      packages/db/test/helpers.ts), incluido el caso de un usuario que
--      pertenece a la vez a una organización proveedora y a una compradora.
--   4. Un trigger adicional impide que `oic_watch_items` (la única tabla de
--      datos propia del módulo comprador en esta ronda) acumule filas bajo
--      una organización que no sea 'comprador' -- defensa en profundidad
--      incluso frente al bypass de superadmin de `app.apply_org_rls`.
--   5. `oic_watch_items` NUNCA referencia una fila de `tenders` (ni de
--      ninguna otra tabla privada del proveedor) por llave foránea: guarda
--      el procedimiento vigilado por sus datos públicos sueltos (fuente,
--      folio, dependencia, título). No existe ninguna ruta de JOIN posible
--      desde el módulo comprador hacia una tabla privada de proveedor.
--   6. `organizations` es tabla compartida por los dos lados (no tiene
--      `org_id` propio, su `id` lo es) -- sus políticas RLS de 0008 solo
--      conocían `app.has_role` (proveedor). Se extienden aquí (DROP+CREATE,
--      mismo patrón que 0019/0040/0041 al corregir funciones existentes)
--      para que un actor OIC pueda ver/editar SU organización compradora
--      vía `app.has_oic_role` -- estrictamente ADITIVO: `has_oic_role` solo
--      es verdadero para organizaciones kind='comprador' con las que el
--      actor tiene una fila real en `oic_memberships` (garantizado por el
--      trigger del punto 3), así que esto no amplía en absoluto lo que un
--      actor del lado proveedor puede ver.
--
-- HONESTO/PENDIENTE (declarado explícitamente, no oculto): REQ-058 pide un
-- almacén de "hechos públicos sin tenant_id" compartido por todo el
-- sistema, pero esa pieza NO existe todavía (cada organización proveedora
-- sigue teniendo su propia copia privada de `tenders`, ver 0005). Por eso
-- `oic_watch_items` no puede "engancharse" hoy a un feed público real de
-- convocatorias -- el OIC captura el folio manualmente. Esta migración NO
-- resuelve REQ-058 ni construye el índice de direccionamiento (REQ-013);
-- solo entrega, de forma completa y probada, el aislamiento de datos/roles
-- que pide REQ-060 y el mínimo de funcionalidad real (dar de alta y
-- consultar procedimientos vigilados) para que el módulo no sea solo un
-- esqueleto de tablas vacías.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'org_kind') then
    create type org_kind as enum ('proveedor', 'comprador');
  end if;
end
$$;

alter table organizations add column if not exists kind org_kind not null default 'proveedor';

do $$
begin
  if not exists (select 1 from pg_type where typname = 'oic_role') then
    -- director_oic: única autoridad para dar de alta/baja miembros y
    -- decidir (mismo rol "cabeza" que 'owner'/'admin' del lado proveedor,
    -- pero SIN acceso a ningún rol de ese lado -- ver punto 2 arriba).
    -- analista_oic: crea/edita procedimientos vigilados, no gestiona miembros.
    -- consulta_oic: solo lectura (paralelo de 'viewer').
    create type oic_role as enum ('director_oic', 'analista_oic', 'consulta_oic');
  end if;
end
$$;

-- Tabla de membresías del lado comprador, físicamente separada de
-- `memberships` (misma forma, catálogo de roles distinto).
create table if not exists oic_memberships (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role oic_role not null,
  status membership_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create index if not exists ix_oic_memberships_org on oic_memberships (org_id);
create index if not exists ix_oic_memberships_user on oic_memberships (user_id);

drop trigger if exists trg_oic_memberships_updated_at on oic_memberships;
create trigger trg_oic_memberships_updated_at
  before update on oic_memberships
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Guardas de exclusión mutua entre los dos catálogos de roles (punto 3).
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER (igual que app.org_has_no_memberships en 0007, mismo
-- motivo): sin esto, el `select ... from organizations` de abajo correría
-- con los privilegios de `app_role` y quedaría sujeto a `sel_organizations`
-- -- durante el bootstrap de una organización nueva (ver
-- org-bootstrap.test.ts) el actor TODAVÍA no es miembro de ella cuando se
-- inserta su propia membresía en la MISMA transacción, así que esa política
-- ocultaría la fila recién creada y `v_kind` daría NULL, rompiendo el
-- bootstrap real con un error falso de "kind incorrecto". SECURITY DEFINER
-- ejecuta con los privilegios del propietario de la función (sin RLS
-- aplicada), viendo el estado real de la tabla, exactamente igual que las
-- funciones de 0007.
create or replace function app.enforce_membership_requires_proveedor_org()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind org_kind;
begin
  select kind into v_kind from organizations where id = new.org_id;
  if v_kind is distinct from 'proveedor' then
    raise exception 'memberships (rol de proveedor) solo admite organizaciones kind=proveedor; % es %', new.org_id, v_kind
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_membership_org_kind on memberships;
create trigger trg_enforce_membership_org_kind
  before insert or update of org_id on memberships
  for each row execute function app.enforce_membership_requires_proveedor_org();

-- Mismo motivo SECURITY DEFINER que la función anterior (bootstrap del
-- primer director_oic de una organización compradora recién creada).
create or replace function app.enforce_oic_membership_requires_comprador_org()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind org_kind;
begin
  select kind into v_kind from organizations where id = new.org_id;
  if v_kind is distinct from 'comprador' then
    raise exception 'oic_memberships (rol de comprador/OIC) solo admite organizaciones kind=comprador; % es %', new.org_id, v_kind
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_oic_membership_org_kind on oic_memberships;
create trigger trg_enforce_oic_membership_org_kind
  before insert or update of org_id on oic_memberships
  for each row execute function app.enforce_oic_membership_requires_comprador_org();

-- Impide además que una organización cambie de "bando" una vez que ya tiene
-- membresías del otro tipo (evita que un `UPDATE organizations SET kind=...`
-- deje huérfanas las guardas de arriba, que solo corren al tocar la
-- membresía, no la organización). SECURITY DEFINER por el mismo motivo que
-- las dos funciones anteriores: sin ella, el `exists(select ... from
-- memberships/oic_memberships ...)` de abajo quedaría sujeto a
-- `sel_memberships`/`sel_oic_memberships` bajo `app_role` y podría dar un
-- falso "sin membresías" si quien cambia el `kind` no tiene el contexto de
-- esa organización activo (p.ej. un superadmin operando sin `org_id` fijado).
create or replace function app.enforce_org_kind_immutable_if_membered()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.kind is distinct from old.kind then
    if new.kind = 'comprador' and exists (select 1 from memberships where org_id = new.id) then
      raise exception 'no se puede marcar % como comprador: ya tiene membresías de proveedor', new.id
        using errcode = '23514';
    end if;
    if new.kind = 'proveedor' and exists (select 1 from oic_memberships where org_id = new.id) then
      raise exception 'no se puede marcar % como proveedor: ya tiene membresías OIC', new.id
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_org_kind_immutable on organizations;
create trigger trg_enforce_org_kind_immutable
  before update of kind on organizations
  for each row execute function app.enforce_org_kind_immutable_if_membered();

-- ---------------------------------------------------------------------------
-- Funciones RLS del lado comprador, paralelas a las de 0007 (mismo patrón
-- SECURITY DEFINER + search_path fijo; mismo motivo: evitar recursión de
-- RLS al leer oic_memberships/platform_admins desde dentro de una política).
-- ---------------------------------------------------------------------------
create or replace function app.has_oic_role(p_org_id uuid, p_roles oic_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from oic_memberships m
    where m.org_id = p_org_id
      and m.user_id = app.current_user_id()
      and m.status = 'active'
      and m.role = any(p_roles)
  )
$$;

-- Mismo rol que `app.org_has_no_memberships` (0007): permite el bootstrap
-- del primer director_oic de una organización compradora recién creada.
create or replace function app.oic_org_has_no_memberships(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (select 1 from oic_memberships m where m.org_id = p_org_id)
$$;

-- Mismo diseño que `app.membership_role` (0019, corrección DB-01): UN solo
-- argumento, siempre resuelve la membresía del propio `app.current_user_id()`
-- -- nunca acepta un `p_user_id` de un tercero.
create or replace function app.oic_membership_role(p_org_id uuid)
returns oic_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.role
  from oic_memberships m
  where m.org_id = p_org_id
    and m.user_id = app.current_user_id()
    and m.status = 'active'
  limit 1
$$;

-- Paralelo de `app.my_organizations()` (0041): 0 argumentos, siempre
-- resuelve las organizaciones OIC del propio `app.current_user_id()`.
create or replace function app.my_oic_organizations()
returns table (org_id uuid, org_name text, org_slug text, role oic_role)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id, o.name, o.slug, m.role
  from oic_memberships m
  join organizations o on o.id = m.org_id
  where m.user_id = app.current_user_id()
    and m.status = 'active'
  order by o.name
$$;

-- ---------------------------------------------------------------------------
-- RLS de oic_memberships (mismo patrón de bootstrap que 0008/memberships).
-- ---------------------------------------------------------------------------
alter table oic_memberships enable row level security;

drop policy if exists sel_oic_memberships on oic_memberships;
create policy sel_oic_memberships on oic_memberships
  for select using (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_oic_role(org_id, '{director_oic,analista_oic,consulta_oic}'::oic_role[]))
  );

drop policy if exists ins_oic_memberships on oic_memberships;
create policy ins_oic_memberships on oic_memberships
  for insert with check (
    app.is_superadmin()
    or (
      org_id = app.current_org_id()
      and (
        app.has_oic_role(org_id, '{director_oic}'::oic_role[])
        or app.oic_org_has_no_memberships(org_id)
      )
    )
  );

drop policy if exists upd_oic_memberships on oic_memberships;
create policy upd_oic_memberships on oic_memberships
  for update using (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_oic_role(org_id, '{director_oic}'::oic_role[]))
  )
  with check (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_oic_role(org_id, '{director_oic}'::oic_role[]))
  );

drop policy if exists del_oic_memberships on oic_memberships;
create policy del_oic_memberships on oic_memberships
  for delete using (
    app.is_superadmin() or (org_id = app.current_org_id() and app.has_oic_role(org_id, '{director_oic}'::oic_role[]))
  );

-- ---------------------------------------------------------------------------
-- Dato propio del módulo comprador: procedimientos que el OIC vigila.
-- Sin FK hacia ninguna tabla privada de proveedor (punto 5 de la nota de
-- diseño) -- el procedimiento se identifica por sus datos públicos sueltos.
-- ---------------------------------------------------------------------------
create table if not exists oic_watch_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  source text not null,
  external_id text not null,
  contracting_body text,
  title text not null,
  -- Alineado con el requisito de gobierno de que toda bandera se reporte
  -- como "riesgo estadístico", nunca como acusación (REQ-116) -- la
  -- clasificación es un enum cerrado de categorías, no texto libre
  -- acusatorio; `risk_note` es la única entrada de texto libre y su
  -- redacción queda bajo criterio humano del OIC, no de este esquema.
  risk_category text not null default 'sin_clasificar'
    check (risk_category in ('sin_clasificar', 'bases_dirigidas', 'plazo_corto', 'proveedor_unico', 'otro')),
  risk_note text,
  status text not null default 'abierto' check (status in ('abierto', 'en_revision', 'cerrado')),
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, source, external_id)
);

create index if not exists ix_oic_watch_items_org on oic_watch_items (org_id, created_at desc);

drop trigger if exists trg_oic_watch_items_updated_at on oic_watch_items;
create trigger trg_oic_watch_items_updated_at
  before update on oic_watch_items
  for each row execute function app.set_updated_at();

-- Defensa en profundidad (punto 4): incluso si algo escribiera aquí con el
-- bypass de superadmin de la política genérica de abajo, la fila solo puede
-- existir bajo una organización kind='comprador'. SECURITY DEFINER por el
-- mismo motivo que las funciones anteriores (ver la primera de ellas para
-- el detalle completo del caso de bootstrap que esto evita).
create or replace function app.enforce_oic_watch_item_requires_comprador_org()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_kind org_kind;
begin
  select kind into v_kind from organizations where id = new.org_id;
  if v_kind is distinct from 'comprador' then
    raise exception 'oic_watch_items solo admite organizaciones kind=comprador; % es %', new.org_id, v_kind
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_oic_watch_item_org_kind on oic_watch_items;
create trigger trg_enforce_oic_watch_item_org_kind
  before insert or update of org_id on oic_watch_items
  for each row execute function app.enforce_oic_watch_item_requires_comprador_org();

-- RLS estándar (mismo generador que 0007, pero con el catálogo de roles OIC).
create or replace function app.apply_oic_org_rls(
  p_table regclass,
  p_read_roles oic_role[],
  p_write_roles oic_role[]
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
    'create policy sel_%s on %s for select using (app.is_superadmin() or (org_id = app.current_org_id() and app.has_oic_role(org_id, %L::oic_role[])))',
    v_name, p_table, p_read_roles
  );

  execute format('drop policy if exists ins_%s on %s', v_name, p_table);
  execute format(
    'create policy ins_%s on %s for insert with check (app.is_superadmin() or (org_id = app.current_org_id() and app.has_oic_role(org_id, %L::oic_role[])))',
    v_name, p_table, p_write_roles
  );

  execute format('drop policy if exists upd_%s on %s', v_name, p_table);
  execute format(
    'create policy upd_%s on %s for update using (app.is_superadmin() or (org_id = app.current_org_id() and app.has_oic_role(org_id, %L::oic_role[]))) with check (app.is_superadmin() or (org_id = app.current_org_id() and app.has_oic_role(org_id, %L::oic_role[])))',
    v_name, p_table, p_write_roles, p_write_roles
  );

  execute format('drop policy if exists del_%s on %s', v_name, p_table);
  execute format(
    'create policy del_%s on %s for delete using (app.is_superadmin() or (org_id = app.current_org_id() and app.has_oic_role(org_id, %L::oic_role[])))',
    v_name, p_table, p_write_roles
  );
end;
$$;

do $$
begin
  -- consulta_oic nunca escribe (paralelo de 'viewer' en el lado proveedor).
  perform app.apply_oic_org_rls('oic_watch_items', '{director_oic,analista_oic,consulta_oic}'::oic_role[], '{director_oic,analista_oic}'::oic_role[]);
end;
$$;

-- ---------------------------------------------------------------------------
-- Extensión aditiva de las políticas de `organizations` (punto 6). Se
-- redefinen las 3 políticas que dependían solo de `app.has_role`; la de
-- INSERT (bootstrap) no cambia -- ya admite a cualquier usuario autenticado,
-- sin importar qué lado de organización vaya a crear.
-- ---------------------------------------------------------------------------
drop policy if exists sel_organizations on organizations;
create policy sel_organizations on organizations
  for select using (
    app.is_superadmin()
    or app.has_role(id, '{owner,admin,analyst,writer,reviewer,viewer}'::org_role[])
    or app.has_oic_role(id, '{director_oic,analista_oic,consulta_oic}'::oic_role[])
  );

drop policy if exists upd_organizations on organizations;
create policy upd_organizations on organizations
  for update using (
    app.is_superadmin()
    or app.has_role(id, '{owner,admin}'::org_role[])
    or app.has_oic_role(id, '{director_oic}'::oic_role[])
  )
  with check (
    app.is_superadmin()
    or app.has_role(id, '{owner,admin}'::org_role[])
    or app.has_oic_role(id, '{director_oic}'::oic_role[])
  );

drop policy if exists del_organizations on organizations;
create policy del_organizations on organizations
  for delete using (
    app.is_superadmin()
    or app.has_role(id, '{owner}'::org_role[])
    or app.has_oic_role(id, '{director_oic}'::oic_role[])
  );

comment on table oic_memberships is
  'REQ-060: membresías del lado comprador (OIC/contraloría) -- catálogo de roles y tabla propios, '
  'separados de memberships/org_role del lado proveedor. Ver trigger trg_enforce_oic_membership_org_kind.';

comment on table oic_watch_items is
  'REQ-060: procedimientos de contratación que un OIC vigila. Sin llave foránea hacia ninguna tabla '
  'privada de proveedor (tenders, proposals, ...) -- se identifica por datos públicos sueltos '
  '(source/external_id/contracting_body/title). REQ-058 (hechos públicos compartidos) sigue '
  'pendiente; hoy el folio se captura manualmente, ver nota de diseño al inicio de esta migración.';
