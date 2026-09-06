import type { TenderRecord } from '@atiende/sources';
import type { TenderIngestRecord } from './ingest-client.js';

/**
 * Convierte un `TenderRecord` normalizado de `@atiende/sources` al shape
 * exacto que `POST /internal/tenders/ingest` de `apps/api` espera
 * (`apps/api/src/modules/tenders/schemas.ts#tenderRecordIngestSchema`).
 *
 * Decisiones de mapeo:
 *  - `sourceVersion` = `snapshot.rawHash` (sha256 del payload crudo de la
 *    fuente): es exactamente la "identidad de versión de origen" que ese
 *    endpoint documenta como clave real de dedupe (reingestar el mismo
 *    `(source, externalId, sourceVersion)` es SIEMPRE no-op, REQ-152/A2).
 *  - `status` de `TenderRecord` (vocabulario de CICLO DE VIDA DE LA FUENTE:
 *    published/clarification/awarded/...) NUNCA se mapea al `status` interno
 *    de `apps/api` (vocabulario de ETAPA DE PIPELINE:
 *    discovered/in_review/go/...) — son taxonomías distintas a propósito.
 *    Se omite y `apps/api` aplica su default ('discovered'), correcto para
 *    cualquier convocatoria recién descubierta.
 *  - `cpvCodes` se deriva de los `classifiers` con `scheme === 'CPV'`.
 *  - `rawData` guarda el `TenderRecord` normalizado completo (evidencia,
 *    trazabilidad; ver REQ-005 "raw lake").
 */
export function mapTenderRecordToIngestRecord(record: TenderRecord): TenderIngestRecord {
  const cpvCodes = record.classifiers.filter((c) => c.scheme === 'CPV').map((c) => c.code);

  return {
    source: record.source,
    externalId: record.externalId,
    title: record.title,
    contractingEntity: record.contractingEntity,
    cpvCodes: cpvCodes.length > 0 ? cpvCodes : undefined,
    classifiers: record.classifiers.map((c) => ({ scheme: c.scheme, code: c.code, description: c.description })),
    budgetAmount: record.budgetAmount,
    currency: record.currency,
    submissionDeadline: record.dates.submissionDeadline?.toISOString(),
    publishedAt: record.dates.published?.toISOString(),
    url: record.url,
    sourceVersion: record.snapshot.rawHash,
    rawData: record as unknown as Record<string, unknown>,
  };
}
