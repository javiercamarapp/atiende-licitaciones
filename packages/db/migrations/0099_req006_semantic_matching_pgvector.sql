-- 0099_req006_semantic_matching_pgvector.sql
-- REQ-006: motor de matching híbrido semántico (pgvector) + léxico
-- (el componente léxico/reglas ya existe, ver packages/sources/src/matching).
-- REQ-061 (parcial): los embeddings quedan scoped por (tenant, procedimiento)
-- -- org_id + tender_id -- con RLS real, verificado (ver
-- apps/api/test/req006-semantic-matching.test.ts). No resuelve el alcance
-- completo de REQ-061 (vector stores de contexto de AGENTE / RAG con
-- few-shot entre tenants): hoy ningún agente usa vector store para eso, así
-- que esa parte del requisito sigue sin material que aislar.
--
-- Intenta habilitar la extensión `vector`; SI EL ENTORNO NO LA TIENE
-- DISPONIBLE (p.ej. PGlite, usado por toda la suite de pruebas de este
-- repo -- confirmado: la versión de `@electric-sql/pglite` instalada no
-- empaqueta la extensión vector) la migración NO FALLA: deja constancia
-- explícita en `app.pgvector_available()` y el código de aplicación
-- (`apps/api/src/modules/matching/semantic.ts`) cae a un fallback
-- determinista real (similitud coseno calculada en TypeScript sobre
-- `embedding_fallback`), nunca a "no hay matching semántico" silencioso ni
-- a un valor inventado.
do $$
begin
  execute 'create extension if not exists vector';
exception when others then
  raise notice 'pgvector no disponible en este entorno (%): se usará el fallback determinista de similitud coseno en aplicación.', sqlerrm;
end
$$;

create or replace function app.pgvector_available()
returns boolean
language sql
stable
as $$
  select exists (select 1 from pg_extension where extname = 'vector')
$$;

-- Embeddings de convocatorias (título + entidad + clasificadores + texto
-- extraído de anexos técnicos reales de `tender_documents.extracted_text`
-- cuando existe -- REQ-006 exige explícitamente "no solo metadatos/título").
-- `embedding_fallback` SIEMPRE se puebla (funciona en cualquier entorno);
-- `embedding_vec` es una columna adicional que solo se crea si pgvector está
-- disponible (bloque dinámico más abajo) y habilita el RPC `match_procedures`
-- de búsqueda por similitud real vía el operador `<=>`.
create table if not exists tender_embeddings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  tender_id uuid not null references tenders (id) on delete cascade,
  source_text_hash text not null,
  model text not null,
  dims integer not null,
  embedding_fallback double precision[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, tender_id)
);

create index if not exists ix_tender_embeddings_org on tender_embeddings (org_id);

drop trigger if exists trg_tender_embeddings_updated_at on tender_embeddings;
create trigger trg_tender_embeddings_updated_at
  before update on tender_embeddings
  for each row execute function app.set_updated_at();

-- Embedding agregado del perfil de organización (capacidades + productos/
-- servicios ya usados por el componente léxico, ver `buildProfileAndEligibility`
-- en apps/api/src/modules/matching/routes.ts). Uno por organización: el
-- perfil no varía por convocatoria.
create table if not exists company_profile_embeddings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null unique references organizations (id) on delete cascade,
  source_text_hash text not null,
  model text not null,
  dims integer not null,
  embedding_fallback double precision[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_company_profile_embeddings_updated_at on company_profile_embeddings;
create trigger trg_company_profile_embeddings_updated_at
  before update on company_profile_embeddings
  for each row execute function app.set_updated_at();

-- Columna vector real + RPC de búsqueda por similitud: SOLO si la extensión
-- está disponible. Cada paso interno está en su propio bloque con manejo de
-- excepción (nunca deja la migración completa a medias por, p. ej., una
-- versión de pgvector sin soporte para un tipo de índice concreto).
do $$
begin
  if app.pgvector_available() then
    execute 'alter table tender_embeddings add column if not exists embedding_vec vector(1536)';
    execute 'alter table company_profile_embeddings add column if not exists embedding_vec vector(1536)';

    begin
      execute 'create index if not exists ix_tender_embeddings_vec on tender_embeddings using ivfflat (embedding_vec vector_cosine_ops) with (lists = 100)';
    exception when others then
      raise notice 'No se pudo crear el índice ivfflat de tender_embeddings (%); la búsqueda por similitud sigue funcionando por escaneo secuencial hasta crear el índice manualmente cuando haya volumen real de datos.', sqlerrm;
    end;

    -- RPC `match_procedures` (nombre exigido por el criterio de aceptación
    -- de REQ-006): dado el embedding de perfil de UNA organización, devuelve
    -- las convocatorias de ESA MISMA organización más similares por coseno.
    -- SECURITY INVOKER (por defecto): corre con los privilegios/RLS de quien
    -- llama -- el filtro `org_id = p_org_id` es defensa en profundidad
    -- explícita, no el único mecanismo de aislamiento (REQ-059/061: la RLS
    -- de `tender_embeddings`, aplicada abajo, es la barrera real).
    execute $sql$
      create or replace function match_procedures(p_org_id uuid, p_query_embedding vector, p_limit integer default 20)
      returns table (tender_id uuid, similarity double precision)
      language sql
      stable
      as $fn$
        select te.tender_id, 1 - (te.embedding_vec <=> p_query_embedding) as similarity
        from tender_embeddings te
        where te.org_id = p_org_id
          and te.embedding_vec is not null
        order by te.embedding_vec <=> p_query_embedding
        limit greatest(p_limit, 0)
      $fn$
    $sql$;
  end if;
end
$$;

-- RLS: mismo patrón que el resto del dominio de tenders/perfil de empresa
-- (app.apply_org_rls, ver 0007/0008/0016). "viewer" puede leer (necesario
-- para que el matching se muestre en pantalla); solo roles de escritura
-- pueden generar/actualizar los embeddings.
do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('tender_embeddings', all_roles, write_roles);
  perform app.apply_org_rls('company_profile_embeddings', all_roles, write_roles);
end
$$;
