-- 0030_expediente_checklist_and_proposals.sql
-- Ronda 3 (E7/E8, apps/api): columnas para persistir `IntegrityChecklist`
-- (7 dimensiones con color propio, REQ-160) sobre `compliance_items`, y el
-- hash de insumos / totales económicos de `ProposalVersionRegistry` /
-- `EconomicProposalBuilder` sobre `proposals`. Solo adiciones.

-- ---------------------------------------------------------------------------
-- compliance_items: se reutiliza la tabla ya existente (sin uso previo real
-- en apps/api) como persistencia de `ChecklistItemResult` por dimensión,
-- ligada a la propuesta (expediente) evaluada, además del vínculo histórico
-- a tender_id que ya usa el trigger de invalidación de 0022.
-- ---------------------------------------------------------------------------
alter table compliance_items add column if not exists proposal_id uuid references proposals (id) on delete cascade;
alter table compliance_items add column if not exists dimension text;
alter table compliance_items
  add constraint chk_compliance_items_dimension
  check (dimension is null or dimension in ('formatos', 'limites', 'firmas', 'anexos_obligatorios', 'vigencias', 'calculos_economicos', 'consistencia_cruzada'));

alter table compliance_items add column if not exists result text;
alter table compliance_items
  add constraint chk_compliance_items_result
  check (result is null or result in ('verde', 'ambar', 'rojo'));

alter table compliance_items add column if not exists checked_at timestamptz;

create index if not exists ix_compliance_items_proposal on compliance_items (org_id, proposal_id);

-- ---------------------------------------------------------------------------
-- proposals: hash de insumos (REQ-161), totales económicos snapshot
-- (consistencia con la carta/anexo generados) y tasa de IVA usada.
-- ---------------------------------------------------------------------------
alter table proposals add column if not exists inputs_hash text;
alter table proposals add column if not exists economic_totals jsonb;
alter table proposals add column if not exists iva_rate numeric(5, 4) not null default 0.16;
alter table proposals add column if not exists bases_tender_version_id uuid references tender_versions (id) on delete set null;

create index if not exists ix_proposals_inputs_hash on proposals (org_id, inputs_hash);
