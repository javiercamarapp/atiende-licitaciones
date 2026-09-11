-- 0107_req026_kyc_negativo_69b_fingerprint.sql
-- REQ-026/REQ-111/REQ-112 (docs/REQUISITOS.md): KYC negativo obligatorio
-- (cruce contra la lista 69-B del SAT -- CFF Art. 69-B, verificado
-- 2026-09-10/11 contra https://www.diputados.gob.mx/LeyesBiblio/pdf/CFF.pdf,
-- última reforma DOF 09-04-2026, ver docs/legal/verificacion-legal.md) y
-- fingerprint de entidad para detectar interpósita persona ENTRE tenants
-- (LGRA Art. 67 / LAASSP nueva Art. 90-V, ya VERIFICADO en
-- docs/legal/verificacion-legal.md antes de esta ronda).
--
-- DECISIÓN DE DISEÑO (mismo criterio que `source_runs`, 0013): estas cinco
-- tablas son de PLATAFORMA/COMPLIANCE, no del propio tenant -- un tenant
-- jamás debe poder leer su propio expediente de KYC en detalle (mucho menos
-- el de otro tenant con el que puede estar coludido), así que su RLS es
-- "solo superadmin" via `app.is_superadmin()`, NUNCA `app.apply_org_rls`
-- (que expondría la fila a la propia organización dueña de `org_id`).
--
-- `sanctions_69b_snapshots`: metadatos de cada corrida de ingesta del
-- listado público de la lista 69-B (una fila por corrida, nunca las 14k+
-- filas del CSV -- eso vive en `sanctions_69b_entries`, con upsert por RFC).
create table if not exists sanctions_69b_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_run_id uuid references source_runs (id) on delete set null,
  source_url text not null,
  fetched_at timestamptz not null,
  -- Fecha "Información actualizada al ..." tal como la publica el propio
  -- CSV del SAT en su primera línea (ver packages/kyc README). NULL cuando
  -- el parseo de esa leyenda falla -- nunca se infiere ni se sustituye por
  -- `fetched_at` (serían dos fechas con significado distinto: cuándo el
  -- SAT dice haber actualizado el listado vs. cuándo ESTE sistema lo bajó).
  list_as_of_date date,
  list_as_of_raw text,
  record_count integer not null,
  raw_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists ix_sanctions_69b_snapshots_fetched_at on sanctions_69b_snapshots (fetched_at desc);

-- `sanctions_69b_entries`: estado ACTUAL por RFC (upsert en cada corrida,
-- no historial completo por snapshot -- el listado real del SAT ronda las
-- ~14,000 filas y una tabla que acumulara una copia completa por corrida
-- nocturna crecería sin límite). El historial de a qué snapshot pertenece
-- la última actualización de cada RFC queda en `snapshot_id`; quien
-- necesite el detalle de oficios/fechas de publicación por RFC debe
-- consultar el CSV crudo (fuera de alcance de este esquema).
create table if not exists sanctions_69b_entries (
  rfc text primary key,
  nombre_contribuyente text not null,
  -- Texto LITERAL de "Situación del contribuyente" tal como lo publica el
  -- SAT ("Presunto" | "Desvirtuado" | "Definitivo" | "Sentencia Favorable"
  -- hoy) -- no se cierra en un enum porque el SAT podría agregar una
  -- categoría nueva sin aviso; la clasificación de riesgo vive en la capa
  -- de aplicación (`packages/kyc`), no en un CHECK de esquema.
  situacion text not null,
  snapshot_id uuid not null references sanctions_69b_snapshots (id) on delete cascade,
  first_seen_snapshot_id uuid not null references sanctions_69b_snapshots (id) on delete cascade,
  updated_at timestamptz not null default now()
);

create index if not exists ix_sanctions_69b_entries_situacion on sanctions_69b_entries (situacion);

do $$
begin
  if not exists (select 1 from pg_type where typname = 'kyc_verdict') then
    create type kyc_verdict as enum ('clear', 'flagged', 'suspended');
  end if;
end
$$;

-- `tenant_kyc_checks`: bitácora de CADA cruce ejecutado (al alta y en cada
-- corrida nocturna) por organización y RFC verificado -- nunca se
-- sobrescribe, es historial de auditoría de compliance.
create table if not exists tenant_kyc_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  snapshot_id uuid references sanctions_69b_snapshots (id) on delete set null,
  rfc_checked text not null,
  matched_situacion text,
  verdict kyc_verdict not null,
  -- 'alta' (PUT /company/profile, captura de RFC) | 'nocturno' (cruce
  -- recurrente "durante la relación", REQ-112).
  trigger text not null,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists ix_tenant_kyc_checks_org on tenant_kyc_checks (org_id, checked_at desc);

-- `tenant_kyc_status`: estado VIGENTE por organización (una fila por
-- tenant), lo que `apps/api` consulta para bloquear/permitir. Separado de
-- `tenant_kyc_checks` (historial) por el mismo motivo que
-- `source_runs`/`app.source_freshness()` separan la bitácora cruda del
-- resumen vigente.
create table if not exists tenant_kyc_status (
  org_id uuid primary key references organizations (id) on delete cascade,
  verdict kyc_verdict not null default 'clear',
  reason text,
  last_check_id uuid references tenant_kyc_checks (id) on delete set null,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_tenant_kyc_status_updated_at on tenant_kyc_status;
create trigger trg_tenant_kyc_status_updated_at
  before update on tenant_kyc_status
  for each row execute function app.set_updated_at();

-- `entity_fingerprint_matches`: candidatos de interpósita persona ENTRE dos
-- tenants distintos (REQ-111). `org_id_a`/`org_id_b` siempre se escriben
-- ordenados (menor primero) para que el par sea único sin importar el
-- orden en que se comparó -- lo aplica `packages/kyc`/el job nocturno, no
-- un trigger, para mantener el esquema simple.
create table if not exists entity_fingerprint_matches (
  id uuid primary key default gen_random_uuid(),
  org_id_a uuid not null references organizations (id) on delete cascade,
  org_id_b uuid not null references organizations (id) on delete cascade,
  score numeric(5, 4) not null,
  matched_fields jsonb not null,
  detected_at timestamptz not null default now(),
  status text not null default 'open',
  created_at timestamptz not null default now(),
  constraint entity_fingerprint_matches_distinct_orgs check (org_id_a <> org_id_b),
  constraint entity_fingerprint_matches_ordered_pair check (org_id_a < org_id_b),
  unique (org_id_a, org_id_b)
);

create index if not exists ix_entity_fingerprint_matches_a on entity_fingerprint_matches (org_id_a);
create index if not exists ix_entity_fingerprint_matches_b on entity_fingerprint_matches (org_id_b);

-- RLS: "solo superadmin" en las cinco tablas, mismo patrón que
-- `source_runs` (0013) -- sin org_id utilizable para `apply_org_rls`
-- (o, en el caso de las que sí tienen `org_id`, deliberadamente NO se usa
-- ese patrón: la propia organización NUNCA debe poder leer su expediente
-- de compliance).
-- NOTA sobre `worker_role` (REQ-112, job nocturno de `apps/worker`): mismo
-- patrón EXACTO que `jobs`/`source_runs` en `0028_worker_role.sql` -- una
-- condición ADICIONAL `current_user = 'worker_role'` sobre cada política,
-- nunca reemplazando `app.is_superadmin()`. El rol `worker_role` ya existe
-- desde 0028; aquí solo se le otorgan los grants mínimos de estas 5 tablas
-- NUEVAS (nunca heredados implícitamente).
alter table sanctions_69b_snapshots enable row level security;
drop policy if exists sel_sanctions_69b_snapshots on sanctions_69b_snapshots;
create policy sel_sanctions_69b_snapshots on sanctions_69b_snapshots for select using (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists ins_sanctions_69b_snapshots on sanctions_69b_snapshots;
create policy ins_sanctions_69b_snapshots on sanctions_69b_snapshots for insert with check (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists upd_sanctions_69b_snapshots on sanctions_69b_snapshots;
create policy upd_sanctions_69b_snapshots on sanctions_69b_snapshots for update using (app.is_superadmin() or current_user = 'worker_role') with check (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists del_sanctions_69b_snapshots on sanctions_69b_snapshots;
create policy del_sanctions_69b_snapshots on sanctions_69b_snapshots for delete using (app.is_superadmin());
grant select, insert, update on sanctions_69b_snapshots to worker_role;

alter table sanctions_69b_entries enable row level security;
drop policy if exists sel_sanctions_69b_entries on sanctions_69b_entries;
create policy sel_sanctions_69b_entries on sanctions_69b_entries for select using (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists ins_sanctions_69b_entries on sanctions_69b_entries;
create policy ins_sanctions_69b_entries on sanctions_69b_entries for insert with check (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists upd_sanctions_69b_entries on sanctions_69b_entries;
create policy upd_sanctions_69b_entries on sanctions_69b_entries for update using (app.is_superadmin() or current_user = 'worker_role') with check (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists del_sanctions_69b_entries on sanctions_69b_entries;
create policy del_sanctions_69b_entries on sanctions_69b_entries for delete using (app.is_superadmin());
grant select, insert, update on sanctions_69b_entries to worker_role;

alter table tenant_kyc_checks enable row level security;
drop policy if exists sel_tenant_kyc_checks on tenant_kyc_checks;
create policy sel_tenant_kyc_checks on tenant_kyc_checks for select using (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists ins_tenant_kyc_checks on tenant_kyc_checks;
create policy ins_tenant_kyc_checks on tenant_kyc_checks for insert with check (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists upd_tenant_kyc_checks on tenant_kyc_checks;
create policy upd_tenant_kyc_checks on tenant_kyc_checks for update using (app.is_superadmin()) with check (app.is_superadmin());
drop policy if exists del_tenant_kyc_checks on tenant_kyc_checks;
create policy del_tenant_kyc_checks on tenant_kyc_checks for delete using (app.is_superadmin());
grant select, insert on tenant_kyc_checks to worker_role;

alter table tenant_kyc_status enable row level security;
drop policy if exists sel_tenant_kyc_status on tenant_kyc_status;
create policy sel_tenant_kyc_status on tenant_kyc_status for select using (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists ins_tenant_kyc_status on tenant_kyc_status;
create policy ins_tenant_kyc_status on tenant_kyc_status for insert with check (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists upd_tenant_kyc_status on tenant_kyc_status;
create policy upd_tenant_kyc_status on tenant_kyc_status for update using (app.is_superadmin() or current_user = 'worker_role') with check (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists del_tenant_kyc_status on tenant_kyc_status;
create policy del_tenant_kyc_status on tenant_kyc_status for delete using (app.is_superadmin());
grant select, insert, update on tenant_kyc_status to worker_role;

alter table entity_fingerprint_matches enable row level security;
drop policy if exists sel_entity_fingerprint_matches on entity_fingerprint_matches;
create policy sel_entity_fingerprint_matches on entity_fingerprint_matches for select using (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists ins_entity_fingerprint_matches on entity_fingerprint_matches;
create policy ins_entity_fingerprint_matches on entity_fingerprint_matches for insert with check (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists upd_entity_fingerprint_matches on entity_fingerprint_matches;
create policy upd_entity_fingerprint_matches on entity_fingerprint_matches for update using (app.is_superadmin() or current_user = 'worker_role') with check (app.is_superadmin() or current_user = 'worker_role');
drop policy if exists del_entity_fingerprint_matches on entity_fingerprint_matches;
create policy del_entity_fingerprint_matches on entity_fingerprint_matches for delete using (app.is_superadmin());
grant select, insert, update on entity_fingerprint_matches to worker_role;

-- Función mínima SECURITY DEFINER (mismo criterio que
-- `app.source_freshness()`, 0018): permite que `apps/api` bloquee el
-- acceso de UN tenant a partir de SU PROPIO veredicto vigente, sin abrir
-- las tablas crudas de compliance a su sesión. Devuelve NULL si nunca se
-- ha corrido un KYC para ese org (estado explícito "sin verificar", nunca
-- confundido con "clear").
create or replace function app.tenant_kyc_verdict(p_org_id uuid)
returns kyc_verdict
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select verdict from tenant_kyc_status where org_id = p_org_id
$$;

-- Expone SOLO la fila de UN RFC puntual de `sanctions_69b_entries` (nunca
-- la tabla completa): usada por `apps/api` al capturar/actualizar el RFC
-- del perfil de empresa (REQ-026, "al alta"). Cualquier usuario autenticado
-- puede llamarla -- el RFC que se consulta es el que la propia
-- organización ya declaró, no información nueva sobre un tercero.
create or replace function app.lookup_negative_list_entry(p_rfc text)
returns table(situacion text, nombre_contribuyente text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select situacion, nombre_contribuyente from sanctions_69b_entries where rfc = p_rfc
$$;

/** Id del snapshot 69-B más reciente (o NULL si nunca se ha corrido ninguna ingesta), para que `apps/api` deje registrado contra qué corrida se evaluó un RFC. */
create or replace function app.latest_69b_snapshot_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from sanctions_69b_snapshots order by fetched_at desc limit 1
$$;

-- Registra una corrida de KYC (REQ-026 "al alta" desde `apps/api`, o
-- REQ-112 "nocturna" desde `apps/worker`) y actualiza el veredicto vigente
-- del tenant en una sola operación atómica. SECURITY DEFINER porque
-- `tenant_kyc_checks`/`tenant_kyc_status` son de solo lectura/escritura
-- para superadmin/worker_role -- pero un tenant SÍ puede disparar SU
-- PROPIA verificación (justo lo que REQ-026 exige al capturar su RFC).
-- Guardia de autorización: si hay una organización activa en la sesión
-- (`app.current_org_id()` no nulo -- el caso de `apps/api`, una petición de
-- un tenant autenticado), `p_org_id` DEBE coincidir con ella -- nunca deja
-- que un tenant registre un check para OTRA organización. Cuando no hay
-- organización activa (`apps/worker`, un proceso de plataforma sin sesión
-- de tenant) se permite cualquier `p_org_id` -- es justo el caso de uso del
-- job nocturno, que evalúa TODOS los tenants en una sola corrida.
create or replace function app.record_tenant_kyc_check(
  p_org_id uuid,
  p_snapshot_id uuid,
  p_rfc_checked text,
  p_matched_situacion text,
  p_verdict kyc_verdict,
  p_trigger text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_check_id uuid;
begin
  if app.current_org_id() is not null and p_org_id <> app.current_org_id() then
    raise exception 'record_tenant_kyc_check: org_id no coincide con la organización activa';
  end if;

  insert into tenant_kyc_checks (org_id, snapshot_id, rfc_checked, matched_situacion, verdict, trigger)
  values (p_org_id, p_snapshot_id, p_rfc_checked, p_matched_situacion, p_verdict, p_trigger)
  returning id into v_check_id;

  insert into tenant_kyc_status (org_id, verdict, reason, last_check_id)
  values (p_org_id, p_verdict, p_matched_situacion, v_check_id)
  on conflict (org_id) do update set
    verdict = excluded.verdict, reason = excluded.reason, last_check_id = excluded.last_check_id;

  return v_check_id;
end;
$$;
