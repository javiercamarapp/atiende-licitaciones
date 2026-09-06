-- 0085_req_login_email_verified_gate.sql
-- REQ-181..195: `POST /auth/login` (modules/auth/routes.ts) necesita saber
-- si el correo de la cuenta ya está verificado (`users.email_verified_at`,
-- 0084) para bloquear el login mientras no lo esté (salvo una cuenta
-- creada exclusivamente vía Google, que nunca pasa por esta ruta -- ver
-- `password_hash is null`). `app.find_user_by_email` (0010) es la única
-- función que expone datos de `users` en contexto PRE-SESIÓN (RLS impide
-- una consulta directa a `users` sin `app.current_user_id()` ya fijado) --
-- se le agrega la columna, en vez de crear una función paralela, porque
-- `POST /auth/login` ya la usaba y así evita una segunda consulta.
--
-- DROP + CREATE (no basta CREATE OR REPLACE): Postgres no permite cambiar
-- la lista de columnas de RETURNS TABLE de una función existente con
-- REPLACE. Conserva el candado DB-01 de 0019 tal cual (rechaza ejecutarse
-- si app.current_user_id() ya está fijado -- solo utilizable pre-sesión).
drop function if exists app.find_user_by_email(text);

create function app.find_user_by_email(p_email text)
returns table (id uuid, password_hash text, is_active boolean, email_verified_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_user_id() is not null then
    raise exception 'find_user_by_email_not_allowed_in_session_context';
  end if;

  return query
    select u.id, u.password_hash, u.is_active, u.email_verified_at
    from users u
    where lower(u.email) = lower(p_email)
    limit 1;
end;
$$;

revoke execute on function app.find_user_by_email(text) from public;
grant execute on function app.find_user_by_email(text) to app_role;
