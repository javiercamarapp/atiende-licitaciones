import { z } from 'zod';
import { isoTimestamp, nullableIsoTimestamp } from '../../lib/schema-helpers.js';

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
  asOfIso: z.string().datetime({ offset: true }).optional(),
});

export const economicLineItemRequestSchema = z.object({
  requirementId: z.string().uuid().optional(),
  concept: z.string().min(1),
  quantity: z.number().positive(),
});

export const economicGenerateSchema = z.object({
  lineItems: z.array(economicLineItemRequestSchema).min(1),
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
export const followupCreateSchema = z.object({
  kind: z.enum(['hito', 'garantia', 'facturacion', 'pago', 'otro']),
  label: z.string().min(1),
  dueDate: z.string().optional(),
  amount: z.number().optional(),
  notes: z.string().optional(),
  reminderLeadDays: z.number().int().min(0).default(3),
  /** Para kind='pago': fecha ISO (YYYY-MM-DD) en que se verificó la factura; el plazo se calcula (17 días hábiles, LAASSP Art. 73) en vez de que el llamador declare `dueDate` a mano. */
  invoiceVerifiedOn: z.string().optional(),
});

export const followupUpdateSchema = z.object({
  status: z.enum(['pending', 'in_progress', 'done', 'overdue', 'cancelled']).optional(),
  notes: z.string().optional(),
  dueDate: z.string().nullable().optional(),
});

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
});
