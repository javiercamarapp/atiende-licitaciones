import { z } from 'zod';
import { isoTimestamp, nullableIsoTimestamp } from '../../lib/schema-helpers.js';

export const TENDER_STATUSES = [
  'discovered',
  'in_review',
  'go',
  'no_go',
  'in_progress',
  'submitted',
  'won',
  'lost',
  'cancelled',
] as const;

export const CHANGE_KINDS = ['publication', 'amendment', 'annex', 'deadline_change', 'clarification', 'cancellation'] as const;

export const tenderSchema = z.object({
  id: z.string().uuid(),
  source: z.string(),
  externalId: z.string(),
  title: z.string(),
  contractingBody: z.string().nullable(),
  cpvCodes: z.array(z.string()),
  budgetAmount: z.number().nullable(),
  currency: z.string(),
  submissionDeadline: nullableIsoTimestamp,
  publishedAt: nullableIsoTimestamp,
  url: z.string().nullable(),
  status: z.enum(TENDER_STATUSES),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

export const tenderListQuerySchema = z.object({
  status: z.enum(TENDER_STATUSES).optional(),
  source: z.string().optional(),
  cursor: z.string().optional(),
  // Nota (API-06/regeneración de OpenAPI): NO se usa `z.coerce.number()`
  // aquí a propósito -- @fastify/swagger no sabe generar el esquema OpenAPI
  // de un tipo zod "coerce" (ZodEffects) y falla con "Cannot read
  // properties of null (reading 'examples')" al construir /docs/json. Se
  // valida como string numérico y se convierte a entero en el handler
  // (ver modules/tenders/routes.ts).
  limit: z
    .string()
    .regex(/^\d+$/, 'limit debe ser un entero positivo')
    .optional(),
});

export const tenderListResponseSchema = z.object({
  items: z.array(tenderSchema),
  nextCursor: z.string().nullable(),
});

export const tenderVersionSchema = z.object({
  id: z.string().uuid(),
  changeKind: z.enum(CHANGE_KINDS),
  sourceVersion: z.string(),
  effectiveAt: isoTimestamp,
  payload: z.record(z.unknown()),
  createdAt: isoTimestamp,
});

export const tenderChangeEventSchema = z.object({
  id: z.string().uuid(),
  changeKind: z.enum(CHANGE_KINDS),
  tenderVersionId: z.string().uuid().nullable(),
  summary: z.string().nullable(),
  createdAt: isoTimestamp,
});

export const sourceFreshnessSchema = z.object({
  sourceId: z.string(),
  status: z.string(),
  lastSuccessAt: nullableIsoTimestamp,
  startedAt: isoTimestamp,
  finishedAt: nullableIsoTimestamp,
  attempts: z.number(),
  ageSeconds: z.number().nullable(),
});

// ---------------------------------------------------------------------------
// Ingesta interna (POST /internal/tenders/ingest)
// ---------------------------------------------------------------------------
export const classifierIngestSchema = z.object({
  scheme: z.string().min(1),
  code: z.string().min(1),
  description: z.string().optional(),
});

export const tenderRecordIngestSchema = z.object({
  source: z.string().min(1),
  externalId: z.string().min(1),
  title: z.string().min(1),
  contractingEntity: z.string().optional(),
  cpvCodes: z.array(z.string()).optional(),
  classifiers: z.array(classifierIngestSchema).optional(),
  budgetAmount: z.number().nonnegative().optional(),
  currency: z.string().length(3).optional(),
  submissionDeadline: z.string().optional(),
  publishedAt: z.string().optional(),
  url: z.string().optional(),
  status: z.enum(TENDER_STATUSES).optional(),
  /**
   * Identidad de versión de origen (p.ej. `snapshot.rawHash` de
   * packages/sources, o cualquier identificador estable de esa versión
   * exacta del procedimiento). Es la clave de dedupe real: reingestar el
   * mismo (source, externalId, sourceVersion) es SIEMPRE un no-op (ver
   * unique(org_id, tender_id, source_version) en tender_versions).
   */
  sourceVersion: z.string().min(1),
  changeKind: z.enum(CHANGE_KINDS).optional(),
  rawData: z.record(z.unknown()).optional(),
});
export type TenderRecordIngest = z.infer<typeof tenderRecordIngestSchema>;

export const ingestBodySchema = z.object({
  records: z.array(tenderRecordIngestSchema).min(1),
  /**
   * Organizaciones a las que replicar estos registros. Si se omite, se
   * aplica a TODAS las organizaciones existentes -- ver nota de diseño en
   * internal-ingest.routes.ts sobre por qué `tenders` es per-organización en
   * este esquema (unique(org_id, source, external_id)).
   */
  organizationIds: z.array(z.string().uuid()).optional(),
});

export const ingestResultItemSchema = z.object({
  source: z.string(),
  externalId: z.string(),
  organizationId: z.string().uuid(),
  action: z.enum(['created', 'updated', 'unchanged']),
  tenderId: z.string().uuid(),
  versionId: z.string().uuid().nullable(),
});

export const ingestResponseSchema = z.object({
  results: z.array(ingestResultItemSchema),
  summary: z.object({
    created: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    organizationsAffected: z.number(),
  }),
});
