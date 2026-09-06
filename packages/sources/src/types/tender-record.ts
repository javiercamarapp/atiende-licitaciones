import { z } from "zod";

/**
 * Fuentes de descubrimiento soportadas. Este union es la ÚNICA lista cerrada
 * de proveedores del sistema (REQ-004/REQ-132..135): el registro de
 * conectores (`src/connectors/registry.ts`) es la única pieza de código
 * autorizada a mapear un `SourceId` a una implementación. Ningún otro módulo
 * debe ramificar sobre estos valores fuera del registro.
 */
export const SourceIdSchema = z.enum([
  "compras-mx",
  "ocds-shcp",
  "dof",
  "pdn-s6",
  "state-portal",
]);
export type SourceId = z.infer<typeof SourceIdSchema>;

export const ClassifierSchemeSchema = z.enum(["CUCoP", "UNSPSC", "CPV", "other"]);
export type ClassifierScheme = z.infer<typeof ClassifierSchemeSchema>;

export const ClassifierSchema = z.object({
  scheme: ClassifierSchemeSchema,
  code: z.string().min(1),
  description: z.string().optional(),
});
export type Classifier = z.infer<typeof ClassifierSchema>;

export const TenderStatusSchema = z.enum([
  "scheduled", // publicación futura anunciada (p.ej. PAAASOP)
  "published",
  "clarification", // en periodo de junta de aclaraciones
  "open_for_submission",
  "closed_for_submission",
  "awarded",
  "cancelled",
  "void", // desierta
  "unknown",
]);
export type TenderStatus = z.infer<typeof TenderStatusSchema>;

export const ProcedureTypeSchema = z.enum([
  "licitacion_publica",
  "invitacion_restringida",
  "adjudicacion_directa",
  "acuerdo_marco",
  "otro",
]);
export type ProcedureType = z.infer<typeof ProcedureTypeSchema>;

export const AttachmentSchema = z.object({
  name: z.string(),
  url: z.string().url().optional(),
  mimeType: z.string().optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/**
 * Fechas relevantes del ciclo de vida del procedimiento. Todas opcionales
 * porque la disponibilidad varía por fuente (p.ej. DOF rara vez publica
 * junta de aclaraciones; ComprasMX sí).
 */
export const TenderDatesSchema = z.object({
  published: z.coerce.date().optional(),
  clarificationMeeting: z.coerce.date().optional(),
  submissionDeadline: z.coerce.date().optional(),
  award: z.coerce.date().optional(),
});
export type TenderDates = z.infer<typeof TenderDatesSchema>;

/**
 * Metadatos del "raw lake" inmutable (REQ-005): de dónde vino el dato, con
 * qué hash y cuándo se obtuvo. `rawHash` es sha256 del payload crudo
 * serializado de forma estable (ver `util/hash.ts`), nunca del registro
 * normalizado (que puede cambiar de forma al evolucionar el mapeo).
 */
export const SourceSnapshotSchema = z.object({
  sourceUrl: z.string().url().optional(),
  fetchedAt: z.coerce.date(),
  rawHash: z.string().regex(/^[a-f0-9]{64}$/i),
  httpStatus: z.number().int().optional(),
});
export type SourceSnapshot = z.infer<typeof SourceSnapshotSchema>;

/**
 * Modelo normalizado de una convocatoria, independiente de la fuente de
 * origen. Todo conector (`SourceConnector`) debe producir instancias de
 * este tipo. No sustituye al modelo canónico OCDS+MxCnet de la base de datos
 * (REQ-008); es la forma intermedia de la capa de descubrimiento antes de
 * persistir.
 */
export const TenderRecordSchema = z.object({
  source: SourceIdSchema,
  /** Identificador único dentro de la fuente (número de expediente/ocid/id). */
  externalId: z.string().min(1),
  title: z.string().min(1),
  contractingEntity: z.string().min(1),
  /** Unidad compradora específica, cuando la fuente la distingue de la entidad. */
  procuringUnit: z.string().optional(),
  procedureType: ProcedureTypeSchema.default("otro"),
  procedureTypeRaw: z.string().optional(),
  classifiers: z.array(ClassifierSchema).default([]),
  budgetAmount: z.number().nonnegative().optional(),
  currency: z.string().length(3).default("MXN"),
  dates: TenderDatesSchema.default({}),
  status: TenderStatusSchema.default("unknown"),
  statusRaw: z.string().optional(),
  url: z.string().url().optional(),
  attachments: z.array(AttachmentSchema).default([]),
  /** Estado (entidad federativa) cuando la fuente lo distingue (portales estatales, PDN). */
  state: z.string().optional(),
  snapshot: SourceSnapshotSchema,
  /**
   * Cursor de paginación de la fuente inmediatamente posterior a este
   * registro, si la fuente lo expone. Lo usa `DiscoveryPipeline` para
   * guardar el `Checkpoint` y poder reanudar exactamente donde se quedó.
   */
  sourceCursor: z.string().optional(),
});
export type TenderRecord = z.infer<typeof TenderRecordSchema>;

/** Valida y normaliza un `TenderRecord`, lanzando `ZodError` si no cumple el esquema. */
export function parseTenderRecord(input: unknown): TenderRecord {
  return TenderRecordSchema.parse(input);
}

/** Clave de deduplicación exacta por fuente (REQ-001: dedupe por número de procedimiento normalizado). */
export function sourceKey(record: Pick<TenderRecord, "source" | "externalId">): string {
  return `${record.source}:${record.externalId}`;
}
