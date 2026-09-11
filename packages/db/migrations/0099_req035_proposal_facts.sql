-- 0099_req035_proposal_facts.sql
-- REQ-035 ("Cada dato renderizado en la propuesta lleva procedencia
-- (`proposal_facts` con fuente, doc_id, página)", tolerancia cero):
-- normaliza en una tabla propia y consultable la procedencia de cada hecho
-- verificable que se renderiza en una propuesta.
--
-- Por qué una tabla nueva y no basta con `proposal_sections.sources`
-- (jsonb, ya existente desde 0006): ese jsonb es un blob por SECCIÓN, sin
-- forma fija ni constraint -- no permite verificar a nivel de esquema "0
-- hechos sin fuente", ni consultar/filtrar hechos individuales por
-- documento/página. `proposal_facts` es la forma/nombre LITERAL que pide el
-- requisito: un renglón por hecho, con su fuente obligatoria.
--
-- Reutiliza el contrato `SourceRef` que YA exige `packages/expediente/src/
-- types.ts` para toda afirmación de una propuesta (comentario ahí mismo:
-- "REQ-027/REQ-035/REQ-164"). `SourceRef` tiene dos variantes reales, no
-- inventadas para esta migración:
--   - { kind: "company_data", refId, capturedAt }   -- dato interno YA
--     aprobado (tarifa, capacidad, experiencia, documento, firmante); no es
--     un documento paginado, por eso NUNCA lleva `page`.
--   - { kind: "clause", documentId, page, clause? } -- cláusula/página real
--     de un documento de las bases; SIEMPRE lleva `page`.
-- `doc_id` en esta tabla es `refId` o `documentId` según el caso.
--
-- "campo sin sources = bug" se refuerza aquí a nivel de ESQUEMA (no solo de
-- aplicación, que puede tener bugs): `doc_id` es NOT NULL y no puede ser
-- cadena vacía/solo-espacios, y un CHECK ata `page` a `source_kind` -- una
-- fila que diga "clause" sin página, o "company_data" con una página que no
-- tiene, es rechazada por Postgres, no solo por el código que la genera.
--
-- Wiring real (de dónde salen los hechos): apps/api/src/lib/expediente/
-- proposal-facts.ts (`recordProposalFacts`), invocado desde los handlers de
-- generación técnica/económica en apps/api/src/modules/expediente/
-- proposal.routes.ts -- reemplaza TODOS los hechos de una sección cada vez
-- que esa sección se regenera (mismo patrón idempotente que `upsertSection`
-- para `proposal_sections`), a partir de los MISMOS `SourceRef` reales que
-- ya produce `TechnicalProposalBuilder`/`EconomicProposalBuilder`
-- (@atiende/expediente) -- nunca un valor fabricado para esta tabla.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'proposal_fact_source_kind') then
    create type proposal_fact_source_kind as enum ('company_data', 'clause');
  end if;
end
$$;

create table if not exists proposal_facts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  proposal_id uuid not null references proposals (id) on delete cascade,
  -- Identificador determinista y re-generable de QUÉ hecho es (p. ej.
  -- "technical:<requirementId>:<indice>" o "economic:<concepto>") -- permite
  -- reemplazar por completo los hechos de una sección al regenerarla.
  fact_key text not null,
  -- Sección de la propuesta que RENDERIZA este hecho. Referencia lógica a
  -- `proposal_sections.section_key` (no FK física: el orden de escritura de
  -- sección/hechos dentro de la misma transacción no está fijado, y una
  -- sección puede no existir aún si el builder no produjo texto).
  section_key text not null,
  -- El valor/afirmación tal como se renderizó (texto o número serializado
  -- como texto) -- lo que un humano leería en la propuesta.
  rendered_value text not null,
  source_kind proposal_fact_source_kind not null,
  -- REQ-035 literal: "fuente, doc_id, página".
  doc_id text not null,
  page integer,
  clause text,
  -- `capturedAt` de `SourceRef` (company_data): puede ser una fecha ISO o,
  -- en varios resolvers actuales de packages/expediente, un id -- se guarda
  -- como texto libre, nunca se castea a timestamp (evitaría insertar el
  -- hecho real por un valor que no es una fecha).
  captured_at text,
  created_at timestamptz not null default now(),
  constraint chk_proposal_facts_doc_id_not_blank check (btrim(doc_id) <> ''),
  constraint chk_proposal_facts_page_matches_kind check (
    (source_kind = 'clause' and page is not null)
    or (source_kind = 'company_data' and page is null)
  ),
  unique (org_id, proposal_id, fact_key)
);

create index if not exists ix_proposal_facts_org_proposal on proposal_facts (org_id, proposal_id);
create index if not exists ix_proposal_facts_section on proposal_facts (org_id, proposal_id, section_key);
create index if not exists ix_proposal_facts_doc on proposal_facts (org_id, doc_id);

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}'; -- viewer nunca escribe
begin
  perform app.apply_org_rls('proposal_facts', all_roles, write_roles);
end;
$$;
