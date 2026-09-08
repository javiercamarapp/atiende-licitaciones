import { z } from 'zod';
import { isoTimestamp, nullableIsoTimestamp, realCalendarDateString } from '../../lib/schema-helpers.js';

// ---------------------------------------------------------------------------
// Documentos de bases + matriz de requisitos (E6)
// ---------------------------------------------------------------------------
export const documentUploadSchema = z.object({
  documentKind: z.enum(['bases', 'anexo', 'aclaracion', 'otro']).default('bases'),
  filename: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  contentBase64: z.string().min(1),
});

export const tenderDocumentSchema = z.object({
  id: z.string().uuid(),
  documentKind: z.string(),
  originalFilename: z.string().nullable(),
  mimeType: z.string().nullable(),
  fileHash: z.string().nullable(),
  fileSizeBytes: z.number().nullable(),
  pageCount: z.number().nullable(),
  textExtractionStatus: z.enum(['pending', 'extracted', 'requires_ocr', 'failed']),
  extractionDetail: z.string().nullable().optional(),
  createdAt: isoTimestamp,
});

export const requirementItemSchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
  requirementKind: z.string(),
  description: z.string(),
  obligatoriedad: z.enum(['obligatorio', 'opcional', 'condicional']),
  clauseRef: z.string().nullable(),
  sourcePage: z.number().nullable(),
  sourceExcerpt: z.string().nullable(),
  deadlineAt: nullableIsoTimestamp,
  responsibleRole: z.string().nullable(),
  assignedTo: z.string().uuid().nullable(),
  matrixStatus: z.enum(['pendiente', 'en_progreso', 'cumplido', 'bloqueado', 'no_evaluable']),
  extractedBy: z.enum(['rule', 'llm']),
  confidence: z.number().nullable(),
  topicKey: z.string().nullable(),
  requiredEvidence: z.array(z.string()),
  invalidatedAt: nullableIsoTimestamp,
  invalidatedReason: z.string().nullable(),
  createdAt: isoTimestamp,
});

export const requirementUpdateSchema = z.object({
  matrixStatus: z.enum(['pendiente', 'en_progreso', 'cumplido', 'bloqueado', 'no_evaluable']).optional(),
  assignedTo: z.string().uuid().nullable().optional(),
});

export const requirementConflictSchema = z.object({
  id: z.string().uuid(),
  topicKey: z.string(),
  kind: z.enum(['deadline_mismatch', 'obligatoriedad_mismatch', 'duplicate_ambiguous']),
  description: z.string(),
  requirementIds: z.array(z.string().uuid()),
  status: z.enum(['abierto', 'escalado', 'resuelto']),
  resolvedAt: nullableIsoTimestamp,
  resolutionNotes: z.string().nullable(),
  createdAt: isoTimestamp,
});

export const conflictResolveSchema = z.object({ resolutionNotes: z.string().min(1) });

export const matrixBuildResponseSchema = z.object({
  itemsCreated: z.number(),
  conflictsCreated: z.number(),
  documentsUsed: z.number(),
  documentsSkipped: z.array(z.object({ documentId: z.string().uuid(), reason: z.string() })),
});

// ---------------------------------------------------------------------------
// Propuesta técnica/económica (E7)
// ---------------------------------------------------------------------------
export const proposalSchema = z.object({
  id: z.string().uuid(),
  tenderId: z.string().uuid(),
  title: z.string(),
  status: z.string(),
  version: z.number(),
  invalidatedAt: nullableIsoTimestamp,
  invalidatedReason: z.string().nullable(),
  inputsHash: z.string().nullable(),
  ivaRate: z.number(),
  economicTotals: z.unknown().nullable(),
  generationReport: z.unknown().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

export const requirementMappingSchema = z.object({
  requirementId: z.string().uuid(),
  kind: z.enum(['capability', 'experience', 'document', 'signer']),
  refKey: z.string().min(1),
});

export const technicalGenerateSchema = z.object({
  mappings: z.array(requirementMappingSchema).default([]),
  conditionEvaluations: z.record(z.string(), z.boolean()).default({}),
  /**
   * AE-01 (docs/auditoria-2/api-expediente.md, ALTA): campo IGNORADO por
   * completo por el servidor -- se mantiene solo por compatibilidad con
   * clientes existentes que ya lo envían. La fecha de evaluación de
   * vigencia SIEMPRE se deriva de `tenders.submission_deadline` (ver
   * `resolveExpedienteAsOfIso` en lib/expediente/dates.ts); un cliente
   * nunca puede "revivir" una tarifa/documento vencido enviando una fecha
   * distinta aquí.
   */
  asOfIso: z.string().datetime({ offset: true }).optional(),
});

export const economicLineItemRequestSchema = z.object({
  requirementId: z.string().uuid().optional(),
  concept: z.string().min(1),
  quantity: z.number().positive(),
});

export const economicGenerateSchema = z.object({
  lineItems: z.array(economicLineItemRequestSchema).min(1),
  /** AE-01: ignorado por el servidor -- ver nota en `technicalGenerateSchema.asOfIso`. */
  asOfIso: z.string().datetime({ offset: true }).optional(),
});

export const proposalSectionSchema = z.object({
  id: z.string().uuid(),
  sectionKey: z.string(),
  title: z.string(),
  content: z.string(),
  sources: z.unknown(),
  version: z.number(),
  updatedAt: isoTimestamp,
});

export const sectionUpdateSchema = z.object({ content: z.string() });

// ---------------------------------------------------------------------------
// Checklist de integridad (E8)
// ---------------------------------------------------------------------------
export const fileArtifactSchema = z.object({
  filename: z.string(),
  extension: z.string(),
  sizeBytes: z.number(),
  pages: z.number().optional(),
});

export const checklistRunSchema = z.object({
  files: z.array(fileArtifactSchema).default([]),
  formatLimits: z
    .object({
      allowedExtensions: z.array(z.string()).default(['pdf']),
      maxFileSizeBytes: z.number().default(20_000_000),
      maxPagesPerFile: z.number().optional(),
      maxUploadSlots: z.number().default(10),
    })
    .default({ allowedExtensions: ['pdf'], maxFileSizeBytes: 20_000_000, maxUploadSlots: 10 }),
  requiredSignatures: z.array(z.object({ role: z.string(), userConfirmedSigned: z.boolean() })).default([]),
  /** Declaración EXPLÍCITA del llamador de qué anexos obligatorios (por `topicKey` o `requirementId`) ya están adjuntos al expediente -- este proyecto no modela todavía un "casillero" de anexo adjunto por requisito, así que se declara aquí en vez de inferirse. */
  presentAnnexRefs: z.array(z.string()).default([]),
  /** AE-01: ignorado por el servidor -- ver nota en `technicalGenerateSchema.asOfIso`. */
  asOfIso: z.string().datetime({ offset: true }).optional(),
});

export const complianceItemSchema = z.object({
  id: z.string().uuid(),
  dimension: z.string().nullable(),
  result: z.enum(['verde', 'ambar', 'rojo']).nullable(),
  label: z.string(),
  notes: z.string().nullable(),
  evidenceRef: z.string().nullable(),
  checkedAt: nullableIsoTimestamp,
});

export const checklistReportSchema = z.object({
  overallStatus: z.enum(['verde', 'ambar', 'rojo']),
  items: z.array(complianceItemSchema),
});

// ---------------------------------------------------------------------------
// Aprobación (E8)
// ---------------------------------------------------------------------------
export const requestReviewSchema = z.object({ scopeRef: z.string().min(1).default('expediente') });

export const approveSchema = z.object({
  scope: z.enum(['seccion', 'documento', 'expediente']).default('expediente'),
  scopeRef: z.string().min(1).default('expediente'),
});

export const commentCreateSchema = z.object({ scopeRef: z.string().min(1).default('expediente'), text: z.string().min(1) });

export const approvalSchema = z.object({
  scope: z.string(),
  scopeRef: z.string(),
  approvedBy: z.string().nullable(),
  approvedByRole: z.string(),
  approvedAt: isoTimestamp,
  inputsHash: z.string(),
  status: z.enum(['vigente', 'invalidada']),
});

export const commentSchema = z.object({
  scopeRef: z.string(),
  authorId: z.string().nullable(),
  authorRole: z.string(),
  text: z.string(),
  createdAt: isoTimestamp,
});

export const approvalStateSchema = z.object({
  state: z.enum(['borrador', 'en_revision', 'aprobado']),
  approvals: z.array(approvalSchema),
  comments: z.array(commentSchema),
  currentInputsHash: z.string(),
  fullyApproved: z.boolean(),
});

// ---------------------------------------------------------------------------
// Paquete final (E8/E9)
// ---------------------------------------------------------------------------
export const packageAssembleResponseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['draft', 'ready']),
  draftReasons: z.array(z.string()),
  missing: z.array(z.string()),
  generatedAt: isoTimestamp,
  notice: z.string(),
});

// ---------------------------------------------------------------------------
// Presentación declarada por el usuario (E9, A15)
// ---------------------------------------------------------------------------
export const submissionDeclareSchema = z.object({
  submittedAt: z.string().datetime({ offset: true }),
  acknowledgementFilename: z.string().optional(),
  acknowledgementContentBase64: z.string().optional(),
  notes: z.string().optional(),
});

export const submissionSchema = z.object({
  id: z.string().uuid(),
  status: z.string(),
  submittedAt: nullableIsoTimestamp,
  acknowledgementStorageRef: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: isoTimestamp,
});

// ---------------------------------------------------------------------------
// Post-adjudicación (E11)
// ---------------------------------------------------------------------------
/**
 * Ronda 5 (E11, REQ-050..056, ver `apps/api/docs/e11-cobertura.md`): kinds
 * ampliados con `penalizacion`/`convenio_modificatorio` (registro de
 * penas convencionales y convenios modificatorios, LOPSRM Art. 59/59 Bis --
 * ver docs/legal/verificacion-legal.md fila REQ-107, sin tope fijo desde la
 * reforma DOF 16-abr-2025). Campos estructurados por kind (todos
 * opcionales a nivel zod porque no todos los kinds los usan; la validación
 * "obligatorio para este kind" ocurre en el handler, igual que ya hacía
 * `invoiceVerifiedOn` para kind='pago'):
 *  - kind='hito'                    -> responsibleParty (nombre/rol/correo del responsable).
 *  - kind='garantia'                -> guaranteeType (tipo: cumplimiento/anticipo/vicios_ocultos/otro);
 *                                       la VIGENCIA de la garantía usa `dueDate` (fecha de vencimiento),
 *                                       no se duplica una segunda fecha con otro nombre.
 *  - kind='facturacion'             -> cfdiReference (folio fiscal/UUID del CFDI) + acceptanceDate
 *                                       (fecha en que la dependencia aceptó la factura -- dispara el
 *                                       cómputo del plazo de pago, igual regla legal que kind='pago').
 *  - kind='pago'                    -> invoiceVerifiedOn (se conserva por compatibilidad; mismo cómputo).
 *  - kind='penalizacion' |
 *    kind='convenio_modificatorio'  -> modificationReference (número/expediente registrado); el monto
 *                                       reutiliza `amount`.
 */
export const followupCreateSchema = z.object({
  kind: z.enum(['hito', 'garantia', 'facturacion', 'pago', 'penalizacion', 'convenio_modificatorio', 'otro']),
  label: z.string().min(1),
  dueDate: z.string().optional(),
  amount: z.number().optional(),
  notes: z.string().optional(),
  reminderLeadDays: z.number().int().min(0).default(3),
  /** kind='hito': responsable con nombre/rol/correo (REQ-050..056: "hitos con fechas y responsables"). */
  responsibleParty: z.string().optional(),
  /** kind='garantia': tipo de garantía (cumplimiento/anticipo/vicios_ocultos/otro). */
  guaranteeType: z.string().optional(),
  /** kind='facturacion': folio fiscal / UUID del CFDI referenciado. */
  cfdiReference: z.string().optional(),
  /** kind='facturacion': fecha ISO (YYYY-MM-DD) en que se aceptó la factura -- dispara el cómputo del plazo de pago (mismo motor que kind='pago'/invoiceVerifiedOn). */
  acceptanceDate: z.string().optional(),
  /** kind='penalizacion' | 'convenio_modificatorio': número/expediente de la pena convencional o convenio modificatorio registrado. */
  modificationReference: z.string().optional(),
  /** Para kind='pago': fecha ISO (YYYY-MM-DD) en que se verificó la factura; el plazo se calcula (17 días hábiles, LAASSP Art. 73, o 20 días naturales bajo el régimen abrogado según REQ-050) en vez de que el llamador declare `dueDate` a mano. */
  invoiceVerifiedOn: z.string().optional(),
  /**
   * AE-09 (docs/auditoria-2/api-expediente.md, MEDIA): días "YYYY-MM-DD"
   * adicionales a excluir del cómputo de días HÁBILES (kind='pago'/'facturacion'
   * bajo el régimen vigente), más allá de sábados/domingos y del calendario
   * OFICIAL cargado en `calendar_holidays` (ver `GET/POST
   * /admin/calendar-holidays`) -- el llamador puede declarar días
   * adicionales que conozca y que aún no estén cargados en la tabla oficial.
   */
  holidays: z.array(z.string()).default([]),
});

export const followupUpdateSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'done', 'overdue', 'cancelled']).optional(),
  notes: z.string().optional(),
  dueDate: z.string().nullable().optional(),
  responsibleParty: z.string().nullable().optional(),
  guaranteeType: z.string().nullable().optional(),
  cfdiReference: z.string().nullable().optional(),
  modificationReference: z.string().nullable().optional(),
});

export const legalRegimeSchema = z.object({
  law: z.string(),
  article: z.string(),
  dofDate: z.string(),
  effectiveDate: z.string(),
  unit: z.enum(['dias_habiles', 'dias_naturales']),
  days: z.number(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// REQ-051: máquina de estados de COBRANZA (facturación/pago post-adjudicación).
// Declarado ANTES de `followupSchema` porque este último la referencia.
// ---------------------------------------------------------------------------
export const COLLECTION_STATUS_ENUM = z.enum([
  'emitida',
  'enviada',
  'en_revision',
  'aprobada_para_pago',
  'pagada',
  'vencida_sin_pago',
  'en_disputa',
]);

export const followupSchema = z.object({
  id: z.string().uuid(),
  tenderId: z.string().uuid(),
  kind: z.string(),
  label: z.string(),
  dueDate: nullableIsoTimestamp,
  status: z.string(),
  amount: z.number().nullable(),
  notes: z.string().nullable(),
  legalReference: z.string().nullable(),
  reminderLeadDays: z.number(),
  jobId: z.string().uuid().nullable(),
  createdAt: isoTimestamp,
  responsibleParty: z.string().nullable(),
  guaranteeType: z.string().nullable(),
  cfdiReference: z.string().nullable(),
  acceptanceDate: nullableIsoTimestamp,
  modificationReference: z.string().nullable(),
  /** AE-09: solo para kind='pago'/'facturacion' -- advertencia explícita de la limitación del calendario de días hábiles usado (ver CALENDAR_LIMITATION_NOTE en lib/expediente/business-days.ts). */
  calendarNote: z.string().nullable(),
  /** AE-09/REQ-050: solo para kind='pago'/'facturacion' -- régimen legal aplicado, versionado por fecha de convocatoria. */
  legalRegime: legalRegimeSchema.nullable(),
  /**
   * REQ-051 (máquina de estados de cobranza): solo para kind='facturacion'/
   * kind='pago' -- ciclo de cobro de ESTA factura/pago concreto, distinto
   * del `status` genérico del seguimiento (pending/in_progress/done/...).
   * `null` para cualquier otro `kind` (nunca aplica). Ver
   * `lib/expediente/collection-lifecycle.ts`.
   */
  collectionStatus: COLLECTION_STATUS_ENUM.nullable(),
  /**
   * Alerta de vencimiento (REQ-056, "recordatorios T-72/24/6h" -- alcance de
   * esta ronda: alerta binaria por día, no por hora): 'vencido' si
   * `dueDate` ya pasó y el seguimiento no está en un estado terminal
   * (done/cancelled); 'proximo' si vence dentro de `reminderLeadDays` días;
   * `null` en cualquier otro caso (sin fecha, terminal, o lejano). REQ-051:
   * para kind='facturacion'/'pago' con `collectionStatus` en
   * `COLLECTION_ALERT_STATES` ('vencida_sin_pago'/'en_disputa'), siempre
   * 'vencido' -- una cobranza vencida sin pago o en disputa activa exige
   * atención inmediata sin importar cuánto falte/haya pasado desde
   * `dueDate` (ver `computeAlertLevel` en `post-award.routes.ts`).
   */
  alertLevel: z.enum(['vencido', 'proximo']).nullable(),
});

export const collectionTransitionRequestSchema = z.object({
  toStatus: COLLECTION_STATUS_ENUM,
  /** Motivo obligatorio de la transición -- nunca se registra un cambio de estado de cobranza sin justificación. */
  reason: z.string().min(1),
  /** Referencia de evidencia (p. ej. folio de comprobante de pago, correo de aprobación) -- opcional. */
  evidenceRef: z.string().optional(),
});

export const collectionStatusHistoryItemSchema = z.object({
  id: z.string().uuid(),
  followupId: z.string().uuid(),
  fromStatus: COLLECTION_STATUS_ENUM.nullable(),
  toStatus: COLLECTION_STATUS_ENUM,
  reason: z.string(),
  actorId: z.string().uuid().nullable(),
  evidenceRef: z.string().nullable(),
  createdAt: isoTimestamp,
});

// ---------------------------------------------------------------------------
// REQ-051 (ronda 6): máquina de estados del contrato post-adjudicación.
// ---------------------------------------------------------------------------
export const CONTRACT_STATUS_ENUM = z.enum([
  'adjudicado',
  'contrato_firmado_declarado',
  'en_ejecucion',
  'entregado',
  'facturado',
  'pagado',
  'cerrado',
  'modificado',
  'penalizado',
  'rescindido',
  'en_inconformidad',
]);

export const contractSchema = z.object({
  id: z.string().uuid(),
  tenderId: z.string().uuid(),
  status: CONTRACT_STATUS_ENUM,
  /** Fecha de fin/vigencia -- insumo directo del radar de renovaciones (REQ-055). */
  endDate: nullableIsoTimestamp,
  contractNumber: z.string().nullable(),
  /** REQ-055 (ronda 8): true cuando el contrato tiene PACTADA una opción contractual de renovación (se puede extender el mismo contrato) -- distingue del caso genérico "el contrato simplemente termina y exigirá una convocatoria nueva". Metadata declarativa capturada por el usuario; nunca inferida del texto del contrato. */
  hasRenewalOption: z.boolean(),
  renewalOptionNotes: z.string().nullable(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});

/** REQ-055: metadatos administrativos del contrato (fecha de fin, número, opción de renovación) -- NO es una transición de estado, no pasa por el grafo de `contract-lifecycle.ts`. */
export const contractMetadataUpdateSchema = z.object({
  endDate: realCalendarDateString.nullable().optional(),
  contractNumber: z.string().min(1).nullable().optional(),
  hasRenewalOption: z.boolean().optional(),
  renewalOptionNotes: z.string().min(1).nullable().optional(),
});

export const contractTransitionRequestSchema = z.object({
  toStatus: CONTRACT_STATUS_ENUM,
  /** Motivo obligatorio de la transición -- nunca se registra un cambio de estado sin justificación. */
  reason: z.string().min(1),
  /** Referencia de evidencia (p. ej. id de documento subido, folio, o descripción libre) -- opcional. */
  evidenceRef: z.string().optional(),
});

export const contractStatusHistoryItemSchema = z.object({
  id: z.string().uuid(),
  fromStatus: CONTRACT_STATUS_ENUM.nullable(),
  toStatus: CONTRACT_STATUS_ENUM,
  reason: z.string(),
  actorId: z.string().uuid().nullable(),
  evidenceRef: z.string().nullable(),
  createdAt: isoTimestamp,
});

// ---------------------------------------------------------------------------
// REQ-052 (ronda 6): extracción del contrato firmado (subido por el usuario;
// el sistema nunca firma).
// ---------------------------------------------------------------------------
export const contractDocumentUploadSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1).optional(),
  contentBase64: z.string().min(1),
});

export const contractDocumentSchema = z.object({
  id: z.string().uuid(),
  contractId: z.string().uuid(),
  originalFilename: z.string().nullable(),
  mimeType: z.string().nullable(),
  fileHash: z.string().nullable(),
  fileSizeBytes: z.number().nullable(),
  pageCount: z.number().nullable(),
  textExtractionStatus: z.enum(['extracted', 'requires_ocr', 'failed']),
  extractionDetail: z.string().nullable(),
  createdAt: isoTimestamp,
});

/** Lista CERRADA de campos que el extractor determinista intenta reconocer (REQ-052). */
export const CONTRACT_FIELD_KEY_ENUM = z.enum([
  'numero_contrato',
  'monto_total',
  'plazo_entrega',
  'garantia_cumplimiento',
  'pena_convencional',
  'deductiva',
  'forma_pago',
  'administrador_contrato',
  'cesion_cobro',
]);

export const contractExtractedFieldSchema = z.object({
  id: z.string().uuid(),
  contractDocumentId: z.string().uuid(),
  fieldKey: CONTRACT_FIELD_KEY_ENUM,
  extractedValue: z.string().nullable(),
  sourcePage: z.number().nullable(),
  sourceClause: z.string().nullable(),
  confidence: z.number().nullable(),
  /** 'sugerido' = extraído, sin confirmar todavía (REQ-052: nunca se da por válido sin confirmación); 'confirmado'/'corregido' = decisión humana ya tomada. */
  status: z.enum(['sugerido', 'confirmado', 'corregido']),
  confirmedValue: z.string().nullable(),
  confirmedBy: z.string().uuid().nullable(),
  confirmedAt: nullableIsoTimestamp,
  createdAt: isoTimestamp,
});

export const contractFieldConfirmSchema = z.object({
  action: z.enum(['confirm', 'correct']),
  /** Obligatorio cuando action='correct'; ignorado (el valor extraído se conserva) cuando action='confirm'. */
  correctedValue: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// REQ-053 (ronda 6): redactor de inconformidades (borrador, sin envío).
// ---------------------------------------------------------------------------
export const inconformidadFundamentoSchema = z.object({
  articulo: z.string(),
  ley: z.string(),
  jurisdiccion: z.string(),
  fechaDof: z.string().nullable(),
  texto: z.string(),
});

export const inconformidadPlazoSchema = z.object({
  diasHabiles: z.number(),
  fechaNotificacionFallo: isoTimestamp,
  fechaLimite: isoTimestamp,
  fundamentoLegal: z.string(),
  bajoTratados: z.boolean(),
});

export const inconformidadGenerateSchema = z.object({
  /** Fecha (YYYY-MM-DD) en que se NOTIFICÓ el fallo -- punto de partida del plazo (REQ-053/Art. 95 LAASSP). Obligatoria: nunca se asume "hoy" para un plazo legal. */
  falloNotifiedOn: realCalendarDateString,
  /** Si el procedimiento es una licitación pública internacional bajo cobertura de tratados (Art. 95 LAASSP: 10 días hábiles en vez de 6). */
  bajoTratados: z.boolean().default(false),
  /**
   * Ronda 7 (REQ-053): capturados a mano por el usuario. Puede ir vacío
   * SOLO si `sourceAutopsyId` aporta al menos un hecho derivado -- el
   * conjunto final (manual + derivado) debe tener al menos uno, nunca un
   * borrador sin ningún hecho (validado en la ruta, no aquí, porque
   * depende de datos de base).
   */
  hechos: z.array(z.string().min(1)).default([]),
  /**
   * Los agravios (fundamento de la impugnación) SIEMPRE los redacta un
   * humano -- nunca se derivan automáticamente de la matriz de requisitos
   * ni de la autopsia: un hueco en el checklist propio es responsabilidad
   * del cliente, no necesariamente una irregularidad de la convocante, y
   * fabricar un "agravio" a partir de eso sería jurídicamente irresponsable
   * (E9). Por eso este campo sigue siendo obligatorio y no admite derivación.
   */
  agravios: z.array(z.string().min(1)).min(1),
  pruebas: z.array(z.string().min(1)).default([]),
  /**
   * Ronda 7 (REQ-053): vincula este borrador a una autopsia del fallo ya
   * registrada (`fallo_autopsies`, REQ-054) -- si se declara, sus datos YA
   * capturados (motivo de desechamiento, comparación de criterios, precio
   * propio vs. ganador) se anexan a `hechos` como restatement factual
   * (nunca se inventa nada nuevo, solo se repite lo que el usuario ya
   * declaró en la autopsia). La autopsia debe pertenecer a la misma
   * convocatoria y no puede tener `ownProposalStatus = 'ganadora'`.
   */
  sourceAutopsyId: z.string().uuid().optional(),
});

export const inconformidadDraftSchema = z.object({
  id: z.string().uuid(),
  tenderId: z.string().uuid(),
  version: z.number(),
  status: z.enum(['borrador', 'revisado']),
  contentHash: z.string(),
  hechos: z.array(z.string()),
  agravios: z.array(z.string()),
  fundamentos: z.array(inconformidadFundamentoSchema),
  pruebas: z.array(z.string()),
  plazo: inconformidadPlazoSchema,
  /**
   * Guardrail anti-frivolidad determinista (REQ-053, docs/REQUISITOS.md):
   * heurística explícita basada en la relación pruebas/agravios -- NUNCA
   * bloquea la generación del borrador, solo advierte. NO es una opinión
   * legal sobre el fondo del caso.
   */
  viability: z.enum(['alta', 'media', 'baja']),
  viabilityRecommendation: z.string(),
  /** Marca visible en todo el documento: nunca se envía, siempre requiere revisión humana de un abogado. */
  disclaimer: z.string(),
  reviewedBy: z.string().uuid().nullable(),
  reviewedAt: nullableIsoTimestamp,
  createdBy: z.string().uuid().nullable(),
  createdAt: isoTimestamp,
});

// ---------------------------------------------------------------------------
// REQ-054 (ronda 6): autopsia del fallo.
// ---------------------------------------------------------------------------
export const NO_DISPONIBLE = 'no disponible' as const;

export const falloCriteriaComparisonItemSchema = z.object({ criterio: z.string().min(1), propio: z.string().min(1), ganador: z.string().min(1) });

export const falloAutopsyCreateSchema = z.object({
  ownProposalStatus: z.enum(['ganadora', 'desechada', 'no_presentada', 'desconocido']).default('desconocido'),
  /** Motivo de desechamiento tal como aparece en el acta de fallo. Si no se captura, se registra explícitamente NO_DISPONIBLE -- nunca se infiere ni se deja vacío en silencio. */
  disqualificationReason: z.string().min(1).optional(),
  ownScore: z.number().optional(),
  winnerScore: z.number().optional(),
  ownPrice: z.number().nonnegative().optional(),
  winnerPrice: z.number().nonnegative().optional(),
  winnerName: z.string().min(1).optional(),
  criteriaComparison: z.array(falloCriteriaComparisonItemSchema).default([]),
  /** Lecciones registradas y vinculadas al perfil de empresa (`company_lessons_learned`) -- al menos una. */
  lessons: z.array(z.string().min(1)).min(1),
});

export const lessonLearnedItemSchema = z.object({
  id: z.string().uuid(),
  falloAutopsyId: z.string().uuid(),
  tenderId: z.string().uuid(),
  lessonText: z.string(),
  createdAt: isoTimestamp,
});

export const falloAutopsiaSchema = z.object({
  id: z.string().uuid(),
  tenderId: z.string().uuid(),
  ownProposalStatus: z.string(),
  /** Motivo de desechamiento de la propuesta propia, o NO_DISPONIBLE si el acta de fallo no lo registra. */
  disqualificationReason: z.string(),
  ownScore: z.number().nullable(),
  winnerScore: z.number().nullable(),
  ownPrice: z.number().nullable(),
  winnerPrice: z.number().nullable(),
  winnerName: z.string(),
  criteriaComparison: z.array(
    z.object({ criterio: z.string(), propio: z.string(), ganador: z.string() })
  ),
  lessons: z.array(z.string()),
  linkedToCompanyProfile: z.boolean(),
  createdAt: isoTimestamp,
});

// ---------------------------------------------------------------------------
// REQ-054 (ronda 7): análisis automatizado de "posibles causas de no
// adjudicación" -- compara la autopsia registrada contra la matriz de
// requisitos (E6) de la convocatoria. Ver
// `lib/expediente/fallo-analysis.ts` (función pura `analyzeFalloCauses`).
// ---------------------------------------------------------------------------
export const falloPossibleCauseSchema = z.object({
  origin: z.enum(['fallo_declarado', 'requisito_pendiente', 'requisito_bloqueado']),
  description: z.string(),
  requirementItemId: z.string().uuid().nullable(),
  category: z.string().nullable(),
  sourcePage: z.number().nullable(),
  clauseRef: z.string().nullable(),
});

export const falloAnalysisSchema = z.object({
  tenderId: z.string().uuid(),
  applicable: z.boolean(),
  hasAutopsy: z.boolean(),
  hasFalloReasonDeclared: z.boolean(),
  hasRequirementMatrix: z.boolean(),
  possibleCauses: z.array(falloPossibleCauseSchema),
  missingDataNotes: z.array(z.string()),
  disclaimer: z.string(),
});

// ---------------------------------------------------------------------------
// REQ-055 (ronda 6): radar de renovaciones.
// ---------------------------------------------------------------------------
export const renewalScanRequestSchema = z.object({
  /** Umbrales de antelación en días (configurable) -- por defecto 90/60/30. */
  leadDaysThresholds: z.array(z.number().int().positive()).min(1).max(10).default([90, 60, 30]),
  // R6-03 (docs/auditoria-2/api-ronda6.md, ALTA): el escaneo pagina los
  // contratos de la organización por cursor (keyset sobre contracts.id) en
  // vez de cargarlos/procesarlos todos en una sola pasada sin límite --
  // `cursor` retoma un escaneo previo `truncated:true` exactamente donde
  // se quedó (nunca reprocesa ni salta contratos).
  cursor: z.string().uuid().nullable().optional(),
  /** Contratos a evaluar por página (una sola consulta conjunta por página, sin N+1). Límite alto para no fragmentar organizaciones normales; acotado para no degradar el tiempo por página. */
  // R6-14 (docs/auditoria-2/api-ronda6-reverificacion.md, BAJA): el techo
  // era 20,000 -- una sola página así podía construir hasta 60,000 alertas
  // candidatas en memoria (más 8 arreglos paralelos para el `unnest`) en
  // una sola transacción, y el conteo de sentencias de R6-09 (estructural,
  // `scanQueries < 100`) en realidad BAJA al subir `pageSize` -- ver
  // `test/expediente-renewal-radar.test.ts` ("R6-09"/"R6-14"). Bajado a un
  // techo defendible, del mismo orden de magnitud que el escaneo de 5,000
  // contratos ya medido y probado en esta suite (R6-03).
  pageSize: z.number().int().positive().max(5000).default(2000),
  /** Límite de tiempo (ms) para todo el request -- al superarlo, el escaneo se detiene ANTES de procesar la siguiente página y responde `truncated:true` + `nextCursor` en vez de dejar la petición HTTP colgada minutos (riesgo de timeout de proxy/gateway y de mantener la transacción abierta demasiado tiempo). */
  maxDurationMs: z.number().int().positive().max(60_000).default(8_000),
});

export const renewalRadarRunSchema = z.object({
  runId: z.string().uuid(),
  alertsCreated: z.number(),
  evaluatedContracts: z.number(),
  /** true si el escaneo se detuvo por `maxDurationMs` antes de terminar todos los contratos de la organización -- reintentar la misma petición con `cursor: nextCursor` continúa exactamente donde se quedó. */
  truncated: z.boolean(),
  nextCursor: z.string().uuid().nullable(),
});

// R6-03: alternativa a ejecutar el escaneo de forma síncrona en la propia
// petición HTTP -- encola un job (`jobs`, kind='renewal_radar_scan') para
// que un worker lo procese en segundo plano, avanzando por páginas y
// persistiendo `progress` en el propio `payload` del job entre cada
// página (mismo patrón, sin envío externo, que `contract_state_alert`/
// `renewal_radar_alert`). NINGÚN consumidor en `apps/worker` procesa este
// `kind` todavía en esta ronda -- el job queda encolado (`status='queued'`)
// para un futuro worker, exactamente igual que los otros dos `kind` de
// jobs de ronda 6 ya documentados como sin consumidor
// (`apps/api/docs/e11-cobertura.md`). Se documenta explícitamente en vez
// de aparentar que ya corre en segundo plano.
export const renewalScanEnqueueRequestSchema = z.object({
  leadDaysThresholds: z.array(z.number().int().positive()).min(1).max(10).default([90, 60, 30]),
  // R6-14 (docs/auditoria-2/api-ronda6-reverificacion.md, BAJA): el techo
  // era 20,000 -- una sola página así podía construir hasta 60,000 alertas
  // candidatas en memoria (más 8 arreglos paralelos para el `unnest`) en
  // una sola transacción, y el conteo de sentencias de R6-09 (estructural,
  // `scanQueries < 100`) en realidad BAJA al subir `pageSize` -- ver
  // `test/expediente-renewal-radar.test.ts` ("R6-09"/"R6-14"). Bajado a un
  // techo defendible, del mismo orden de magnitud que el escaneo de 5,000
  // contratos ya medido y probado en esta suite (R6-03).
  pageSize: z.number().int().positive().max(5000).default(2000),
});

export const renewalScanEnqueueResponseSchema = z.object({
  jobId: z.string().uuid(),
  status: z.literal('queued'),
});

export const renewalAlertSchema = z.object({
  id: z.string().uuid(),
  contractId: z.string().uuid().nullable(),
  tenderId: z.string().uuid().nullable(),
  sourceKind: z.enum(['contract_end_date', 'historical_pattern']),
  predictedDate: isoTimestamp,
  leadDays: z.number(),
  confidence: z.number(),
  notes: z.string(),
  jobId: z.string().uuid().nullable(),
  status: z.string(),
  createdAt: isoTimestamp,
});

// R6-12 (docs/auditoria-2/api-ronda6-reverificacion.md, MEDIA): `GET
// /renewals/alerts` no paginaba -- una sola consulta sin `limit` (32,4 MB /
// 60,000 filas medidos por el reverificador con 20,000 contratos). Mismo
// patrón keyset ya usado en `GET /organizations/:orgId/memberships`
// (`lib/cursor.ts`): `limit`/`cursor` de entrada, `nextCursor` de salida.
export const renewalAlertsListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'limit debe ser un entero positivo')
    .optional(),
});

export const renewalAlertsListResponseSchema = z.object({
  items: z.array(renewalAlertSchema),
  nextCursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// REQ-055 (ronda 8) -- `GET /renewals/upcoming`: el cliente de negocio
// concreto que exige el requisito. A diferencia de `POST /renewals/scan` +
// `GET /renewals/alerts` (que persisten alertas/jobs como efecto
// secundario, bajo demanda), este endpoint es de SOLO LECTURA: calcula en
// vivo, a partir de `contracts.end_date`, los tres umbrales 90/60/30 (o los
// que se pidan) de forma SIMULTÁNEA y EXPLÍCITA -- un mismo contrato puede
// aparecer en más de un grupo de urgencia a la vez (p. ej. a 20 días del
// vencimiento aparece en los tres) -- nunca colapsa a un solo `alertLevel`
// binario como el mecanismo genérico de `post-award.routes.ts`.
export const renewalUpcomingQuerySchema = z.object({
  /** CSV de umbrales en días (p. ej. "90,60,30"); por defecto 90/60/30. Máximo 10 valores, mismo tope que `renewalScanRequestSchema`. */
  thresholds: z.string().regex(/^\d+(,\d+)*$/, 'thresholds debe ser una lista de enteros separados por comas, p. ej. "90,60,30"').optional(),
  /** Tope de contratos evaluados (los más próximos a vencer primero) -- ver `truncated` en la respuesta si se alcanza. */
  limit: z.string().regex(/^\d+$/, 'limit debe ser un entero positivo').optional(),
});

export const RENEWAL_URGENCY_ENUM = z.enum(['urgente', 'proxima', 'seguimiento']);

export const renewalUpcomingItemSchema = z.object({
  contractId: z.string().uuid(),
  tenderId: z.string().uuid(),
  tenderTitle: z.string(),
  contractingBody: z.string().nullable(),
  contractNumber: z.string().nullable(),
  /** REQ-055 (ronda 8): si este contrato tiene pactada una opción de renovación -- ver `contracts.has_renewal_option`. */
  hasRenewalOption: z.boolean(),
  renewalOptionNotes: z.string().nullable(),
  endDate: isoTimestamp,
  /** Días calendario restantes hasta `endDate`, calculados con la MISMA fecha de referencia (`asOfDate`) que el resto de la respuesta -- nunca recalculado por el cliente contra su propio reloj. */
  daysUntilEnd: z.number().int(),
  leadDays: z.number().int(),
  confidence: z.number(),
});

export const renewalUpcomingGroupSchema = z.object({
  urgency: RENEWAL_URGENCY_ENUM,
  leadDays: z.number().int(),
  items: z.array(renewalUpcomingItemSchema),
});

export const renewalUpcomingResponseSchema = z.object({
  asOfDate: realCalendarDateString,
  /** Umbrales efectivamente usados, ascendente (p. ej. [30, 60, 90]) -- un grupo por umbral, SIEMPRE presente aunque no tenga elementos. */
  thresholds: z.array(z.number().int()),
  totalContractsEvaluated: z.number().int(),
  /** true si se alcanzó `limit` contratos evaluados (ordenados por vencimiento más próximo primero) -- puede haber más contratos con `end_date` futura sin evaluar todavía. Reintentar con un `limit` mayor si aplica. */
  truncated: z.boolean(),
  groups: z.array(renewalUpcomingGroupSchema),
});
