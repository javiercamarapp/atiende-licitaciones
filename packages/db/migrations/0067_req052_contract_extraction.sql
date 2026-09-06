-- 0067_req052_contract_extraction.sql
-- Ronda 6 (E11, apps/api), REQ-052: el usuario SUBE el contrato firmado
-- (declarativo -- el sistema NUNCA firma ni verifica una firma real, ver
-- `contract-lifecycle.ts` sobre el estado `contrato_firmado_declarado`) y
-- se extrae texto con el MISMO motor que las bases (E6, `extractDocumentText`
-- -- PDF con capa de texto o texto plano; sin OCR -> `requires_ocr`, nunca
-- se inventa contenido). `contract_documents` es una tabla PROPIA (no se
-- reutiliza `tender_documents`) porque cuelga de `contracts`, no
-- directamente de `tenders` -- un tender sin contrato registrado (REQ-051)
-- nunca puede tener un documento de contrato asociado.

create table if not exists contract_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  contract_id uuid not null references contracts (id) on delete cascade,
  storage_ref text not null,
  file_hash text not null,
  extracted_text text,
  page_count integer,
  uploaded_by uuid references users (id) on delete set null,
  original_filename text,
  mime_type text,
  text_extraction_status text not null,
  extraction_detail text,
  file_size_bytes bigint,
  created_at timestamptz not null default now()
);

alter table contract_documents
  add constraint chk_contract_documents_extraction_status
  check (text_extraction_status in ('extracted', 'requires_ocr', 'failed'));

create index if not exists ix_contract_documents_org_contract on contract_documents (org_id, contract_id);

-- ---------------------------------------------------------------------------
-- contract_extracted_fields: campos detectados por el extractor determinista
-- (`lib/expediente/contract-extraction.ts`, regex, sin LLM). REQ-052:
-- "el usuario confirma o corrige; nunca se dan por válidos sin
-- confirmación" -- `status` empieza SIEMPRE en 'sugerido'; solo
-- `POST .../fields/:fieldId/confirm` (rol de escritura) puede moverlo a
-- 'confirmado'/'corregido', y solo entonces `confirmed_value`/
-- `confirmed_by`/`confirmed_at` quedan poblados.
-- ---------------------------------------------------------------------------
create table if not exists contract_extracted_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  contract_document_id uuid not null references contract_documents (id) on delete cascade,
  field_key text not null,
  extracted_value text not null,
  source_page integer,
  source_clause text,
  confidence numeric(3, 2) not null,
  status text not null default 'sugerido',
  confirmed_value text,
  confirmed_by uuid references users (id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table contract_extracted_fields
  add constraint chk_contract_extracted_fields_key
  check (field_key in (
    'numero_contrato', 'monto_total', 'plazo_entrega', 'garantia_cumplimiento',
    'pena_convencional', 'deductiva', 'forma_pago', 'administrador_contrato', 'cesion_cobro'
  ));
alter table contract_extracted_fields
  add constraint chk_contract_extracted_fields_status
  check (status in ('sugerido', 'confirmado', 'corregido'));

create index if not exists ix_contract_extracted_fields_document on contract_extracted_fields (org_id, contract_document_id);

alter table contract_documents enable row level security;
alter table contract_extracted_fields enable row level security;

do $$
declare
  all_roles org_role[] := '{owner,admin,analyst,writer,reviewer,viewer}';
  write_roles org_role[] := '{owner,admin,analyst,writer,reviewer}';
begin
  perform app.apply_org_rls('contract_documents', all_roles, write_roles);
  perform app.apply_org_rls('contract_extracted_fields', all_roles, write_roles);
end;
$$;
