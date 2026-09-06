-- 0082_req181_notification_preferences.sql
-- REQ-181..195: preferencias de notificación por USUARIO (no por
-- organización -- un usuario puede pertenecer a varias, la preferencia es
-- de la persona, igual que user_totp_secrets, 0057). Una fila por usuario,
-- creada perezosamente (upsert) la primera vez que `GET/PUT
-- /me/notification-preferences` la necesite -- ausencia de fila == todo
-- activado (DEFAULT_NOTIFICATION_PREFERENCES de packages/mail, "lista de
-- EXCLUSIÓN, no de opt-in").
--
-- RLS: mismo patrón "propia fila" que user_totp_secrets -- cada usuario
-- solo ve/edita SU PROPIA fila. El endpoint de baja de un clic
-- (`GET/POST /mail/unsubscribe?...`, enlace firmado) corre en contexto
-- ANÓNIMO (quien hace click no necesariamente tiene una sesión activa) --
-- usa `app.set_notification_preference_unsigned`, SECURITY DEFINER, que
-- confía en el `userId` YA verificado por la firma HMAC del enlace
-- (`MailService.verifySignedLink`), nunca en un valor de entrada sin
-- verificar.
create table if not exists notification_preferences (
  user_id uuid primary key references users (id) on delete cascade,
  tender_matches boolean not null default true,
  tender_changes boolean not null default true,
  approvals boolean not null default true,
  submission boolean not null default true,
  deadlines boolean not null default true,
  document_expiration boolean not null default true,
  post_award boolean not null default true,
  weekly_summary boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_notification_preferences_updated_at on notification_preferences;
create trigger trg_notification_preferences_updated_at
  before update on notification_preferences
  for each row execute function app.set_updated_at();

alter table notification_preferences enable row level security;

drop policy if exists sel_notification_preferences on notification_preferences;
create policy sel_notification_preferences on notification_preferences for select using (user_id = app.current_user_id());
drop policy if exists ins_notification_preferences on notification_preferences;
create policy ins_notification_preferences on notification_preferences for insert with check (user_id = app.current_user_id());
drop policy if exists upd_notification_preferences on notification_preferences;
create policy upd_notification_preferences on notification_preferences for update using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());

-- Baja de un clic (enlace firmado, sin sesión): apaga UNA categoría (o
-- todas las opcionales si p_category es null) para p_user_id -- el
-- `userId` viene YA verificado por la firma HMAC del enlace
-- (`mailService.verifySignedLink`), nunca de un valor de entrada crudo.
-- `p_category` usa los mismos nombres de columna que la tabla (snake_case)
-- -- `apps/api` valida contra una lista cerrada antes de llamar, pero la
-- función igual falla explícito ante cualquier otro valor.
create or replace function app.set_notification_preference_unsigned(p_user_id uuid, p_category text, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into notification_preferences (user_id) values (p_user_id)
  on conflict (user_id) do nothing;

  if p_category is null then
    update notification_preferences
      set tender_matches = p_enabled, tender_changes = p_enabled, approvals = p_enabled,
          submission = p_enabled, deadlines = p_enabled, document_expiration = p_enabled,
          post_award = p_enabled, weekly_summary = p_enabled
      where user_id = p_user_id;
    return;
  end if;

  if p_category not in (
    'tender_matches', 'tender_changes', 'approvals', 'submission',
    'deadlines', 'document_expiration', 'post_award', 'weekly_summary'
  ) then
    raise exception 'set_notification_preference_categoria_no_permitida: %', p_category;
  end if;

  execute format('update notification_preferences set %I = $1 where user_id = $2', p_category)
    using p_enabled, p_user_id;
end;
$$;

revoke execute on function app.set_notification_preference_unsigned(uuid, text, boolean) from public;
grant execute on function app.set_notification_preference_unsigned(uuid, text, boolean) to app_role;
