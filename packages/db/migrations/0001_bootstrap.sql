-- 0001_bootstrap.sql
-- Esquema para helpers de seguridad, rol de aplicación con privilegios limitados
-- (las migraciones se ejecutan como el rol propietario/superusuario; el runtime
-- de la API SIEMPRE debe usar app_role vía `SET LOCAL ROLE app_role` para que
-- las políticas RLS definidas en 0008 se apliquen de verdad).
--
-- Nota importante (ver packages/db/README.md): en PGlite la conexión por
-- defecto es el superusuario "postgres", que SIEMPRE evade RLS. Si el runtime
-- no hace `SET LOCAL ROLE app_role`, todas las políticas quedan sin efecto.

create schema if not exists app;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_role') then
    create role app_role nologin nosuperuser nobypassrls noinherit;
  end if;
end
$$;

grant usage on schema public to app_role;
grant usage on schema app to app_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to app_role;
alter default privileges in schema public
  grant usage, select on sequences to app_role;
alter default privileges in schema app
  grant execute on functions to app_role;

-- Función genérica de trigger para mantener updated_at.
create or replace function app.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
