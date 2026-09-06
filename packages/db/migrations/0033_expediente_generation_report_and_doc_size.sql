-- 0033_expediente_generation_report_and_doc_size.sql
-- Ronda 3: columnas adicionales descubiertas al construir los endpoints
-- reales de apps/api sobre @atiende/expediente. Solo adiciones.

-- Snapshot del último reporte de generación (bloqueos/faltantes de la
-- propuesta técnica y económica) -- evita recalcular en cada GET y permite
-- exponer "listar faltantes/bloqueos" (E7) de forma barata.
alter table proposals add column if not exists generation_report jsonb;

-- Tamaño real del archivo (bytes), necesario para la dimensión "límites"
-- del checklist de integridad (REQ-160) sobre documentos de bases/anexos.
alter table tender_documents add column if not exists file_size_bytes integer;
