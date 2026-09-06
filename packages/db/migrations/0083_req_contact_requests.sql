-- 0083_req_contact_requests.sql
-- Ampliación 2 §2 (docs/AMPLIACION-2-SALIDA.md): `POST /public/contact`
-- (formulario de contacto público, anónimo -- landing/marketing). Tabla de
-- auditoría/soporte, NUNCA tenant (no hay organización todavía en este
-- punto del embudo): `ins` es pública (`with check (true)`, mismo criterio
-- que `ins_users` para el registro anónimo, 0008); `sel` restringida a
-- superadmin de plataforma (`GET /admin/contact-requests`).
create table if not exists contact_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text,
  message text not null,
  ip text,
  user_agent text,
  created_at timestamptz not null default now()
);

create index if not exists ix_contact_requests_created on contact_requests (created_at desc);
create index if not exists ix_contact_requests_email on contact_requests (lower(email));

alter table contact_requests enable row level security;

drop policy if exists ins_contact_requests on contact_requests;
create policy ins_contact_requests on contact_requests for insert with check (true);

drop policy if exists sel_contact_requests on contact_requests;
create policy sel_contact_requests on contact_requests for select using (app.is_superadmin());
