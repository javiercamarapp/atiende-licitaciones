-- 0099_req032_proposal_section_fingerprints.sql
-- REQ-032 (BLUEPRINT L625-627, G-11): "Huellas de similitud (MinHash) entre
-- tenants sin cruzar contenido; generación condicionada al estilo/evidencia
-- de cada tenant". REQ-034: prohibido compartir plantillas/contenido entre
-- tenants competidores -- este esquema es la parte de datos del detector
-- real (`@atiende/agents` `CrossTenantSimilarityDetector`,
-- `apps/worker/src/agents/similarity-store.pg.ts`).
--
-- Dos tablas, con visibilidad deliberadamente DISTINTA:
--
-- 1) `proposal_section_fingerprints`: SOLO huellas MinHash (enteros) y
--    claves de banda LSH (hashes) de cada sección generada -- NUNCA texto.
--    Un MinHash es una función de un solo sentido sobre el conjunto de
--    shingles: nadie puede reconstruir el contenido original a partir de la
--    firma. Por eso `worker_role` puede leerla SIN filtro de organización
--    (necesita comparar la huella de un tenant contra las de TODOS los
--    demás) sin que eso viole "sin cruzar contenido" -- lo único que cruza
--    la frontera de organización es la huella, nunca el texto. Cada
--    organización sigue viendo/escribiendo únicamente SU PROPIA fila por el
--    camino normal (`app.apply_org_rls`, igual que `proposal_sections`).
--
-- 2) `proposal_similarity_flags`: el evento de cumplimiento cuando una
--    huella superó el umbral contra la de OTRA organización. A diferencia
--    de la tabla de huellas, esta SÍ nombra ambas organizaciones
--    (`org_id`/`matched_org_id`) -- por eso es visible EXCLUSIVAMENTE para
--    `app.is_superadmin()` (equipo de cumplimiento/anticolusión), nunca
--    para la propia organización señalada ni para la organización con la
--    que coincidió: mostrarle a un tenant la identidad de con qué
--    competidor coincidió sería, en sí mismo, una fuga de información entre
--    tenants (el tipo exacto de cosa que REQ-034 prohíbe), incluso sin
--    exponer el contenido de ninguna propuesta. Append-only, igual que
--    `audit_log` (0008): sin política de UPDATE/DELETE para nadie.

create table if not exists proposal_section_fingerprints (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  -- `tender_id` es SOLO una clave de agrupación (org_id, tender_id,
  -- section_key) -- deliberadamente SIN `references tenders (id)`.
  -- `proponer_seccion_propuesta` (apps/worker/src/agents/business-tools.ts)
  -- nunca valida que `tenderId` corresponda a una fila real de `tenders`
  -- (a diferencia de `leer_bases`/`resumir_cambios_convocatoria`, que sí la
  -- leen) -- es un identificador de agrupación provisto por quien invoca
  -- la herramienta, no una entidad que este esquema pueda garantizar que
  -- exista. Una FK aquí rompería ese contrato ya existente (encontrado
  -- corriendo la suite real de `apps/worker`: la FK hacía fallar el propio
  -- flujo de redacción con un tenderId de convocatoria en borrador/aún no
  -- persistida).
  tender_id uuid not null,
  section_key text not null,
  algorithm_version smallint not null,
  signature integer[] not null,
  band_hashes text[] not null,
  shingle_count integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, tender_id, section_key, algorithm_version)
);

-- Búsqueda de candidatos por solape de bandas (`band_hashes && $1`): GIN
-- sobre un arreglo usa el opclass `array_ops` por defecto, que soporta
-- `&&`/`@>`/`<@` sin ninguna extensión adicional (no requiere `intarray`,
-- que es solo para `integer[]` con operadores propios).
create index if not exists ix_proposal_section_fingerprints_bands on proposal_section_fingerprints using gin (band_hashes);

drop trigger if exists trg_proposal_section_fingerprints_updated_at on proposal_section_fingerprints;
create trigger trg_proposal_section_fingerprints_updated_at
  before update on proposal_section_fingerprints
  for each row execute function app.set_updated_at();

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('proposal_section_fingerprints', all_roles, write_roles);
end
$$;

-- worker_role: SELECT cross-tenant (necesario para comparar huellas ENTRE
-- organizaciones -- el propósito mismo de esta tabla), condicionado
-- únicamente por identidad de conexión (mismo patrón que
-- `withWorkerPlatformReadContext`, PROPOSAL-06/0098). INSERT/UPDATE
-- (upsert) SÍ acotados a `org_id = app.current_org_id()` como defensa en
-- profundidad -- el worker nunca debería escribir la huella de una
-- organización que no sea la del contexto de ejecución actual.
grant select on proposal_section_fingerprints to worker_role;
grant insert, update on proposal_section_fingerprints to worker_role;

drop policy if exists sel_proposal_section_fingerprints_worker_role on proposal_section_fingerprints;
create policy sel_proposal_section_fingerprints_worker_role on proposal_section_fingerprints
  for select using (current_user = 'worker_role');

drop policy if exists ins_proposal_section_fingerprints_worker_role on proposal_section_fingerprints;
create policy ins_proposal_section_fingerprints_worker_role on proposal_section_fingerprints
  for insert with check (current_user = 'worker_role' and org_id = app.current_org_id());

drop policy if exists upd_proposal_section_fingerprints_worker_role on proposal_section_fingerprints;
create policy upd_proposal_section_fingerprints_worker_role on proposal_section_fingerprints
  for update using (current_user = 'worker_role' and org_id = app.current_org_id())
  with check (current_user = 'worker_role' and org_id = app.current_org_id());

-- ---------------------------------------------------------------------------
-- proposal_similarity_flags: solo superadmin lee; solo worker_role inserta;
-- nadie actualiza/borra (append-only, como audit_log).
-- ---------------------------------------------------------------------------
create table if not exists proposal_similarity_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  -- `tender_id`/`matched_tender_id`: mismo motivo que en
  -- `proposal_section_fingerprints` arriba -- identificadores de
  -- agrupación, deliberadamente sin FK a `tenders`.
  tender_id uuid not null,
  section_key text not null,
  similarity numeric(4, 3) not null,
  matched_org_id uuid not null references organizations (id) on delete cascade,
  matched_tender_id uuid not null,
  matched_section_key text not null,
  regenerated boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists ix_proposal_similarity_flags_org on proposal_similarity_flags (org_id, created_at desc);
create index if not exists ix_proposal_similarity_flags_matched_org on proposal_similarity_flags (matched_org_id, created_at desc);

alter table proposal_similarity_flags enable row level security;

drop policy if exists sel_proposal_similarity_flags on proposal_similarity_flags;
create policy sel_proposal_similarity_flags on proposal_similarity_flags
  for select using (app.is_superadmin());

grant select on proposal_similarity_flags to worker_role;
grant insert on proposal_similarity_flags to worker_role;

drop policy if exists ins_proposal_similarity_flags_worker_role on proposal_similarity_flags;
create policy ins_proposal_similarity_flags_worker_role on proposal_similarity_flags
  for insert with check (current_user = 'worker_role');

-- `INSERT ... RETURNING` exige, además del WITH CHECK de arriba, que la fila
-- resultante sea VISIBLE bajo alguna política de SELECT (mismo
-- descubrimiento ya documentado para `agent_runs` en
-- PROPOSAL-06/0098 -- ver `apps/worker/src/agents/db-context.ts`): sin
-- esto, el propio INSERT del worker fallaría con "new row violates
-- row-level security policy" al pedir RETURNING id. Acotado a
-- `current_user = 'worker_role'`, igual que el INSERT -- NO amplía qué
-- puede leer un tenant ni un superadmin (esos ya tienen su propia
-- política arriba).
drop policy if exists sel_proposal_similarity_flags_worker_role on proposal_similarity_flags;
create policy sel_proposal_similarity_flags_worker_role on proposal_similarity_flags
  for select using (current_user = 'worker_role');
