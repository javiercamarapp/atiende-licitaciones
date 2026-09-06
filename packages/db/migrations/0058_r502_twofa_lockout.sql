-- 0058_r502_twofa_lockout.sql
-- R5-02 (docs/auditoria-2/api-ronda5.md, CRÍTICA): los endpoints de
-- verificación TOTP (/auth/2fa/enroll, /auth/2fa/verify-enrollment,
-- /auth/2fa/step-up) solo heredaban el límite GLOBAL (300 req/min por IP,
-- ver rate-limit-settings.ts) -- un código de 6 dígitos (10^6 combinaciones)
-- se puede agotar en minutos distribuido entre unas pocas IPs sin disparar
-- nunca un comportamiento distinto del tráfico normal.
--
-- Esta migración agrega la mitad "contador de fallos POR USUARIO,
-- persistido en DB" del fix (la otra mitad, un límite de tasa por IP
-- específico de estos 3 endpoints, es un `config.rateLimit` por ruta en
-- apps/api -- ver `lib/rate-limit-settings.ts`, tier `twoFactor`). Un
-- contador en memoria (como el resto de `@fastify/rate-limit`) se resetea
-- al reiniciar el proceso y no protege contra que el atacante rote de IP
-- para esquivar el límite por IP -- este contador es POR USUARIO, con
-- bloqueo PROGRESIVO (cada vez que se alcanza un múltiplo de 5 fallos
-- consecutivos, la ventana de bloqueo se duplica: 5, 10, 20, 40... minutos,
-- con un tope de 24h), independiente de cuántas IPs distintas lo intenten.
create table if not exists twofa_lockouts (
  user_id uuid primary key references users (id) on delete cascade,
  failed_count integer not null default 0,
  lock_count integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_twofa_lockouts_updated_at on twofa_lockouts;
create trigger trg_twofa_lockouts_updated_at
  before update on twofa_lockouts
  for each row execute function app.set_updated_at();

alter table twofa_lockouts enable row level security;

-- Mismo patrón que user_totp_secrets/step_up_sessions (0057): cada usuario
-- solo ve/gestiona su propia fila, basado en app.current_user_id().
drop policy if exists sel_twofa_lockouts on twofa_lockouts;
create policy sel_twofa_lockouts on twofa_lockouts for select using (user_id = app.current_user_id());
drop policy if exists ins_twofa_lockouts on twofa_lockouts;
create policy ins_twofa_lockouts on twofa_lockouts for insert with check (user_id = app.current_user_id());
drop policy if exists upd_twofa_lockouts on twofa_lockouts;
create policy upd_twofa_lockouts on twofa_lockouts for update using (user_id = app.current_user_id()) with check (user_id = app.current_user_id());
drop policy if exists del_twofa_lockouts on twofa_lockouts;
create policy del_twofa_lockouts on twofa_lockouts for delete using (user_id = app.current_user_id());
