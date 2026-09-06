-- 0071_req172_google_oidc.sql
-- REQ-172..180 (docs/REQUISITOS.md §34.1, AMPLIACION-2 §1): autenticación
-- con Google (OIDC estándar: Authorization Code + PKCE + state + nonce).
--
-- Contenido:
--  1. users.password_hash pasa a NULLABLE: una cuenta creada exclusivamente
--     vía Google (REQ-174/REQ-179) no tiene contraseña propia. Login por
--     email+contraseña para esa cuenta debe rechazarse SIEMPRE (nunca un
--     hash "vacío" comparable, nunca una excepción) -- `apps/api`
--     (`modules/auth/routes.ts`, login) trata `password_hash is null` igual
--     que "cuenta inexistente" para el oráculo de timing (API-03): sigue
--     ejecutando `verifyPassword` (scrypt real) contra el hash ficticio,
--     nunca contra `null`.
--  2. user_identities: vincula un usuario a una identidad de un proveedor
--     externo (Google por ahora). `(provider, subject)` único evita que el
--     mismo `sub` de Google se vincule a dos usuarios distintos;
--     `(provider, user_id)` único evita más de una identidad del mismo
--     proveedor por usuario. RLS: cada usuario solo ve/inserta SU PROPIA
--     fila (mismo patrón que user_totp_secrets, 0057) -- el INSERT real
--     durante el login con Google se hace con `app.current_user_id()` YA
--     fijado al usuario verificado (encontrado por email/subject, o recién
--     creado en la MISMA transacción), nunca a partir de un valor de
--     entrada sin verificar.
--  3. oauth_states: PKCE `code_verifier` + `nonce` por intento de login,
--     identificados por un `id` embebido en un JWT firmado devuelto como
--     `state` (ver apps/api/src/modules/auth/google/state.ts) -- RLS
--     habilitada SIN políticas (igual que refresh_tokens, 0017): todo
--     acceso pasa por las funciones SECURITY DEFINER de abajo (crear al
--     iniciar el flujo, consumir UNA SOLA VEZ al terminarlo -- anti-CSRF,
--     anti-replay de state/nonce, y TTL real vía `expires_at`).
--  4. app.find_identity_by_subject: análogo pre-sesión a
--     app.find_user_by_email (0019, endurecida por DB-01) -- solo
--     invocable ANTES de que exista contexto de sesión.
--  5. app.accept_pending_invitations_for_user: variante de
--     app.accept_invitation (0017) que acepta TODAS las invitaciones
--     pendientes y no expiradas del email YA VERIFICADO del propio usuario
--     (derivado de `users.email` por `p_user_id`, NUNCA un email de
--     entrada sin verificar) -- usada cuando un login de Google crea una
--     cuenta nueva que además tenía invitación(es) pendiente(s) (REQ-174:
--     "entra por invitación pendiente" en vez de compuerta `sin_acceso`).
--     Exige `app.current_user_id()` ya fijado e igual a `p_user_id` (mismo
--     endurecimiento anti-forjado que 0054 aplicó a `record_auth_event`
--     tras API-14) -- sin este candado, cualquier código corriendo como
--     `app_role` podría hacerse pasar por cualquier `p_user_id` y robar sus
--     invitaciones pendientes.

alter table users alter column password_hash drop not null;

create table if not exists user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  provider text not null,
  subject text not null,
  email text not null,
  linked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (provider, subject),
  unique (provider, user_id)
);

create index if not exists ix_user_identities_user on user_identities (user_id);

alter table user_identities enable row level security;

drop policy if exists sel_user_identities on user_identities;
create policy sel_user_identities on user_identities for select using (user_id = app.current_user_id());
drop policy if exists ins_user_identities on user_identities;
create policy ins_user_identities on user_identities for insert with check (user_id = app.current_user_id());

create table if not exists oauth_states (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'google',
  code_verifier text not null,
  nonce text not null,
  redirect_uri text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

-- RLS habilitada SIN políticas a propósito (mismo patrón que
-- refresh_tokens, 0017): nadie accede a esta tabla directamente vía
-- app_role (ni siquiera "su propio" registro -- no hay noción de dueño
-- antes de autenticar); todo acceso pasa por las funciones SECURITY
-- DEFINER de abajo, que validan la operación exacta permitida.
alter table oauth_states enable row level security;

create or replace function app.create_oauth_state(
  p_id uuid, p_provider text, p_code_verifier text, p_nonce text, p_redirect_uri text, p_expires_at timestamptz
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into oauth_states (id, provider, code_verifier, nonce, redirect_uri, expires_at)
  values (p_id, p_provider, p_code_verifier, p_nonce, p_redirect_uri, p_expires_at)
$$;

-- Consumo ATÓMICO de un solo uso (mismo patrón check-y-mutación que
-- app.rotate_refresh_token, 0043): un UPDATE ... WHERE consumed_at IS NULL
-- AND expires_at > now() RETURNING garantiza que, bajo concurrencia, como
-- mucho UNA petición gane el consumo -- cualquier reintento con el MISMO
-- `state` (CSRF replay, doble callback, nonce reutilizado -- el nonce vive
-- 1:1 dentro de esta misma fila de un solo uso) ve 0 filas y la aplicación
-- responde 400, nunca reprocesa el login.
create or replace function app.consume_oauth_state(p_id uuid)
returns table (code_verifier text, nonce text, redirect_uri text, provider text)
language sql
security definer
set search_path = public, pg_temp
as $$
  update oauth_states
  set consumed_at = now()
  where id = p_id and consumed_at is null and expires_at > now()
  returning oauth_states.code_verifier, oauth_states.nonce, oauth_states.redirect_uri, oauth_states.provider
$$;

create or replace function app.find_identity_by_subject(p_provider text, p_subject text)
returns table (user_id uuid, email text, is_active boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if app.current_user_id() is not null then
    raise exception 'find_identity_by_subject_not_allowed_in_session_context';
  end if;

  return query
    select u.id, u.email, u.is_active
    from user_identities ui
    join users u on u.id = ui.user_id
    where ui.provider = p_provider and ui.subject = p_subject
    limit 1;
end;
$$;

create or replace function app.accept_pending_invitations_for_user(p_user_id uuid)
returns table (out_org_id uuid, out_role org_role)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_invitation invitations%rowtype;
begin
  if app.current_user_id() is null or app.current_user_id() <> p_user_id then
    raise exception 'accept_pending_invitations_actor_mismatch';
  end if;

  select lower(email) into v_email from users where id = p_user_id;
  if v_email is null then
    return;
  end if;

  for v_invitation in
    select * from invitations
    where lower(email) = v_email and status = 'pending' and expires_at > now()
    order by created_at asc
    for update skip locked
  loop
    insert into memberships (org_id, user_id, role)
    values (v_invitation.org_id, p_user_id, v_invitation.role)
    on conflict (org_id, user_id) do update set role = excluded.role, status = 'active';

    update invitations set status = 'accepted' where id = v_invitation.id;

    out_org_id := v_invitation.org_id;
    out_role := v_invitation.role;
    return next;
  end loop;
  return;
end;
$$;

revoke execute on function app.create_oauth_state(uuid, text, text, text, text, timestamptz) from public;
grant execute on function app.create_oauth_state(uuid, text, text, text, text, timestamptz) to app_role;
revoke execute on function app.consume_oauth_state(uuid) from public;
grant execute on function app.consume_oauth_state(uuid) to app_role;
revoke execute on function app.find_identity_by_subject(text, text) from public;
grant execute on function app.find_identity_by_subject(text, text) to app_role;
revoke execute on function app.accept_pending_invitations_for_user(uuid) from public;
grant execute on function app.accept_pending_invitations_for_user(uuid) to app_role;
