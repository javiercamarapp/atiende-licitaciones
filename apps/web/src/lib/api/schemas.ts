// Esquemas zod escritos a mano a partir del código real de apps/api (sus
// módulos en apps/api/src/modules/*/schemas.ts), no generados
// automáticamente: no hay acceso de build-time al OpenAPI de apps/api desde
// este workspace (requiere la API arrancada y una sesión válida en
// `/docs/json`), así que se mantienen sincronizados a mano. Sirven para
// validar en runtime la forma de las respuestas (defensa ante drift de
// contrato) y como única fuente de los tipos TS del cliente.
import { z } from "zod";

// --- auth ------------------------------------------------------------------
export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type AuthTokens = z.infer<typeof authTokensSchema>;

/**
 * E19/E21 (docs/BACKLOG.md): `hasPassword`/`googleLinked` son ADITIVOS
 * (`GET /me`, apps/api/src/modules/me/routes.ts) -- `.default(false)` para
 * que las decenas de pruebas existentes de toda la app que mockean `/me`
 * SIN estos dos campos (escritas antes de esta ronda) sigan validando: un
 * mock viejo se interpreta como "sin contraseña propia ni Google
 * vinculado" en vez de romper con un error de esquema. El uso real (contra
 * apps/api real) siempre los declara explícitos.
 */
export const userPublicSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  hasPassword: z.boolean().default(false),
  googleLinked: z.boolean().default(false),
});
export type UserPublic = z.infer<typeof userPublicSchema>;

// --- auth/google (REQ-172..180 — login con Google, OIDC) --------------------
// Espejo exacto de apps/api/src/modules/auth/google/schemas.ts.
export const googleStartResponseSchema = z.object({
  authorizationUrl: z.string().url(),
});
export type GoogleStartResponse = z.infer<typeof googleStartResponseSchema>;

/**
 * Respuesta única de `GET /auth/google/callback` y `POST
 * /auth/google/verify-2fa` (ver docstring del schema real en
 * apps/api/src/modules/auth/google/schemas.ts): un objeto plano con campos
 * opcionales, nunca una unión discriminada — se valida con `.refine()` a
 * mano en `lib/api/google.ts` cuál combinación de campos corresponde a cada
 * `status` antes de usarlos, en vez de confiar ciegamente en la forma.
 */
export const googleAuthResultSchema = z.object({
  status: z.enum(["ok", "sin_acceso", "requires_2fa"]),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  pendingToken: z.string().optional(),
});
export type GoogleAuthResult = z.infer<typeof googleAuthResultSchema>;

// --- organizations -----------------------------------------------------------
export const ORG_ROLES = ["owner", "admin", "analyst", "writer", "reviewer", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const MEMBERSHIP_ADMIN_ROLES: OrgRole[] = ["owner", "admin"];
export const WRITE_ROLES: OrgRole[] = ["owner", "admin", "analyst", "writer", "reviewer"];
export const DECISION_ROLES: OrgRole[] = ["owner", "admin", "analyst"];
export const GO_NO_GO_ROLES: OrgRole[] = ["owner", "admin", "analyst", "reviewer"];

export const myOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(ORG_ROLES),
});
export type MyOrg = z.infer<typeof myOrgSchema>;

export const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ORG_ROLES),
  status: z.string(),
  token: z.string().optional(),
});
export type Invitation = z.infer<typeof invitationSchema>;

// --- company (E2) ------------------------------------------------------------
export const companyProfileSchema = z.object({
  id: z.string(),
  legalName: z.string(),
  tradeName: z.string().nullable(),
  taxId: z.string().nullable(),
  description: z.string().nullable(),
  sector: z.string().nullable(),
  foundedYear: z.number().nullable(),
  employeeCount: z.number().nullable(),
  annualRevenue: z.number().nullable(),
  website: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CompanyProfile = z.infer<typeof companyProfileSchema>;

export const capabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  isVerified: z.boolean(),
  evidenceRef: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Capability = z.infer<typeof capabilitySchema>;

export const signatorySchema = z.object({
  id: z.string(),
  fullName: z.string(),
  roleTitle: z.string().nullable(),
  idDocumentRef: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Signatory = z.infer<typeof signatorySchema>;

export const DOCUMENT_STATUSES = ["valid", "expiring_soon", "expired", "pending_verification"] as const;
export const documentSchema = z.object({
  id: z.string(),
  documentType: z.string(),
  storageRef: z.string(),
  fileHash: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  status: z.enum(DOCUMENT_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CompanyDocument = z.infer<typeof documentSchema>;

export const RATE_STATUSES = ["draft", "approved", "archived"] as const;
export const rateSchema = z.object({
  id: z.string(),
  itemCode: z.string(),
  description: z.string(),
  unit: z.string(),
  unitPrice: z.number(),
  currency: z.string(),
  status: z.enum(RATE_STATUSES),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  validFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Rate = z.infer<typeof rateSchema>;

// --- tenders (E3/E4) ---------------------------------------------------------
export const TENDER_STATUSES = [
  "discovered",
  "in_review",
  "go",
  "no_go",
  "in_progress",
  "submitted",
  "won",
  "lost",
  "cancelled",
] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

export const CHANGE_KINDS = ["publication", "amendment", "annex", "deadline_change", "clarification", "cancellation"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const tenderSchema = z.object({
  id: z.string(),
  source: z.string(),
  externalId: z.string(),
  title: z.string(),
  contractingBody: z.string().nullable(),
  cpvCodes: z.array(z.string()),
  budgetAmount: z.number().nullable(),
  currency: z.string(),
  submissionDeadline: z.string().nullable(),
  publishedAt: z.string().nullable(),
  url: z.string().nullable(),
  status: z.enum(TENDER_STATUSES),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Tender = z.infer<typeof tenderSchema>;

export const tenderListResponseSchema = z.object({
  items: z.array(tenderSchema),
  nextCursor: z.string().nullable(),
});
export type TenderListResponse = z.infer<typeof tenderListResponseSchema>;

export const tenderVersionSchema = z.object({
  id: z.string(),
  changeKind: z.enum(CHANGE_KINDS),
  sourceVersion: z.string(),
  effectiveAt: z.string(),
  payload: z.record(z.unknown()),
  createdAt: z.string(),
});
export type TenderVersion = z.infer<typeof tenderVersionSchema>;

export const tenderChangeEventSchema = z.object({
  id: z.string(),
  changeKind: z.enum(CHANGE_KINDS),
  tenderVersionId: z.string().nullable(),
  summary: z.string().nullable(),
  createdAt: z.string(),
});
export type TenderChangeEvent = z.infer<typeof tenderChangeEventSchema>;

export const SOURCE_RUN_STATUSES = [
  "ok",
  "failed",
  "captcha",
  "interface_changed",
  "permission_missing",
  "down",
  "rate_limited",
  "not_configured",
  "ingest_failed",
] as const;
export type SourceRunStatus = (typeof SOURCE_RUN_STATUSES)[number];

export const sourceFreshnessSchema = z.object({
  sourceId: z.string(),
  status: z.string(),
  lastSuccessAt: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  attempts: z.number(),
  ageSeconds: z.number().nullable(),
});
export type SourceFreshness = z.infer<typeof sourceFreshnessSchema>;

// --- matching (E5) -------------------------------------------------------------
export const matchCriterionSchema = z.object({
  criterion: z.string(),
  score: z.number(),
  maxScore: z.number(),
  explanation: z.string(),
});

export const eligibilityStatusSchema = z.enum(["cumple", "no_cumple", "no_evaluable"]);
export type EligibilityStatus = z.infer<typeof eligibilityStatusSchema>;

export const eligibilityCriterionSchema = z.object({
  requirement: z.string(),
  status: eligibilityStatusSchema,
  explanation: z.string(),
});

export const matchResultSchema = z.object({
  tenderId: z.string(),
  tenderKey: z.string(),
  relevance: z.object({
    score: z.number(),
    criteria: z.array(matchCriterionSchema),
  }),
  eligibility: z.object({
    status: eligibilityStatusSchema,
    criteria: z.array(eligibilityCriterionSchema),
  }),
  missingProfileFields: z.array(z.string()),
});
export type MatchResult = z.infer<typeof matchResultSchema>;

export const matchListResponseSchema = z.object({ items: z.array(matchResultSchema) });

// --- go/no-go -------------------------------------------------------------------
export const goNoGoDecisionSchema = z.object({
  id: z.string(),
  tenderId: z.string(),
  decision: z.enum(["go", "no_go"]),
  reasons: z.array(z.string()),
  decidedBy: z.string().nullable(),
  decidedAt: z.string(),
});
export type GoNoGoDecision = z.infer<typeof goNoGoDecisionSchema>;

// --- agents (persistencia de packages/agents) -----------------------------------
export const agentRunSchema = z.object({
  id: z.string(),
  agentName: z.string(),
  status: z.string(),
  totalSteps: z.number(),
  completedSteps: z.number(),
  correlationId: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

export const TOOL_CALL_AUTH_STATUSES = ["auto", "pending", "approved", "denied"] as const;
export const toolCallSchema = z.object({
  id: z.string(),
  agentRunId: z.string(),
  toolName: z.string(),
  authorizationStatus: z.enum(TOOL_CALL_AUTH_STATUSES),
  status: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

// --- admin / back office (E10, superadmin) --------------------------------------
export const adminOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.string(),
  memberCount: z.number(),
});
export type AdminOrg = z.infer<typeof adminOrgSchema>;

export const adminConnectorFreshnessSchema = z.object({
  sourceId: z.string(),
  status: z.string(),
  lastSuccessAt: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  attempts: z.number(),
  ageSeconds: z.number().nullable(),
  isStale: z.boolean(),
});
export type AdminConnectorFreshness = z.infer<typeof adminConnectorFreshnessSchema>;

export const adminJobSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  kind: z.string(),
  status: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  lastError: z.string().nullable(),
  nextRunAt: z.string(),
  createdAt: z.string(),
});
export type AdminJob = z.infer<typeof adminJobSchema>;

export const adminCostByOrgSchema = z.object({
  orgId: z.string(),
  orgName: z.string(),
  totalRuns: z.number(),
  totalEstimatedCostUsd: z.number(),
  estimated: z.literal(true),
});
export type AdminCostByOrg = z.infer<typeof adminCostByOrgSchema>;

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const incidentSchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  severity: z.string(),
  status: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});
export type Incident = z.infer<typeof incidentSchema>;

export const pendingApprovalSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  orgName: z.string(),
  toolName: z.string(),
  agentRunId: z.string(),
  createdAt: z.string(),
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

// --- memberships (ronda 4: GET /organizations/:orgId/memberships) --------------
export const membershipSchema = z.object({
  userId: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
  role: z.enum(ORG_ROLES),
  status: z.string(),
  joinedAt: z.string(),
});
export type Membership = z.infer<typeof membershipSchema>;

export const membershipListResponseSchema = z.object({
  items: z.array(membershipSchema),
  nextCursor: z.string().nullable(),
});
export type MembershipListResponse = z.infer<typeof membershipListResponseSchema>;

// --- audit log (ronda 4: GET /audit-log, GET /admin/audit-log) -----------------
export const auditLogEntrySchema = z.object({
  id: z.string(),
  orgId: z.string().nullable(),
  actorId: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  requestId: z.string().nullable(),
  /** REQ-171: id de correlación de negocio (trazabilidad de extremo a
   * extremo de un flujo); `null` para eventos anteriores a esta ronda o sin
   * correlación conocida. `.optional()` porque este campo es más nuevo que
   * el resto del contrato (apps/api lo agregó en paralelo a esta ronda). */
  correlationId: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>;

export const auditLogListResponseSchema = z.object({
  items: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
});
export type AuditLogListResponse = z.infer<typeof auditLogListResponseSchema>;

// --- company: experience (E2 -- solo lectura desde apps/web, usada como
// selector de fuente al mapear la propuesta técnica en Redacción) -------------
export const experienceSchema = z.object({
  id: z.string(),
  title: z.string(),
  clientName: z.string().nullable(),
  description: z.string().nullable(),
  contractValue: z.number().nullable(),
  currency: z.string().nullable(),
  startDate: z.string().nullable(),
  endDate: z.string().nullable(),
  isVerified: z.boolean(),
  evidenceRef: z.string().nullable(),
  verifiable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Experience = z.infer<typeof experienceSchema>;

// ===============================================================================
// Expediente de participación (E6-E9/E11) -- 26 rutas bajo
// /expediente/tenders/:tenderId/..., ver apps/api/README.md módulo "expediente"
// y apps/api/src/modules/expediente/schemas.ts (fuente de verdad).
// ===============================================================================

// --- documentos + matriz de requisitos (E6) -------------------------------------
export const DOCUMENT_KINDS = ["bases", "anexo", "aclaracion", "otro"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const TEXT_EXTRACTION_STATUSES = ["pending", "extracted", "requires_ocr", "failed"] as const;
export type TextExtractionStatus = (typeof TEXT_EXTRACTION_STATUSES)[number];

export const tenderDocumentSchema = z.object({
  id: z.string(),
  documentKind: z.string(),
  originalFilename: z.string().nullable(),
  mimeType: z.string().nullable(),
  fileHash: z.string().nullable(),
  fileSizeBytes: z.number().nullable(),
  pageCount: z.number().nullable(),
  textExtractionStatus: z.enum(TEXT_EXTRACTION_STATUSES),
  extractionDetail: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type TenderDocument = z.infer<typeof tenderDocumentSchema>;

export const MATRIX_STATUSES = ["pendiente", "en_progreso", "cumplido", "bloqueado", "no_evaluable"] as const;
export type MatrixStatus = (typeof MATRIX_STATUSES)[number];

export const requirementItemSchema = z.object({
  id: z.string(),
  documentId: z.string().nullable(),
  requirementKind: z.string(),
  description: z.string(),
  obligatoriedad: z.enum(["obligatorio", "opcional", "condicional"]),
  clauseRef: z.string().nullable(),
  sourcePage: z.number().nullable(),
  sourceExcerpt: z.string().nullable(),
  deadlineAt: z.string().nullable(),
  responsibleRole: z.string().nullable(),
  assignedTo: z.string().nullable(),
  matrixStatus: z.enum(MATRIX_STATUSES),
  extractedBy: z.enum(["rule", "llm"]),
  confidence: z.number().nullable(),
  topicKey: z.string().nullable(),
  requiredEvidence: z.array(z.string()),
  invalidatedAt: z.string().nullable(),
  invalidatedReason: z.string().nullable(),
  createdAt: z.string(),
});
export type RequirementItem = z.infer<typeof requirementItemSchema>;

export const requirementConflictSchema = z.object({
  id: z.string(),
  topicKey: z.string(),
  kind: z.enum(["deadline_mismatch", "obligatoriedad_mismatch", "duplicate_ambiguous"]),
  description: z.string(),
  requirementIds: z.array(z.string()),
  status: z.enum(["abierto", "escalado", "resuelto"]),
  resolvedAt: z.string().nullable(),
  resolutionNotes: z.string().nullable(),
  createdAt: z.string(),
});
export type RequirementConflict = z.infer<typeof requirementConflictSchema>;

export const matrixBuildResponseSchema = z.object({
  itemsCreated: z.number(),
  conflictsCreated: z.number(),
  documentsUsed: z.number(),
  documentsSkipped: z.array(z.object({ documentId: z.string(), reason: z.string() })),
});
export type MatrixBuildResponse = z.infer<typeof matrixBuildResponseSchema>;

// --- propuesta técnica/económica (E7) -------------------------------------------
export const proposalSchema = z.object({
  id: z.string(),
  tenderId: z.string(),
  title: z.string(),
  status: z.string(),
  version: z.number(),
  invalidatedAt: z.string().nullable(),
  invalidatedReason: z.string().nullable(),
  inputsHash: z.string().nullable(),
  ivaRate: z.number(),
  economicTotals: z.unknown().nullable(),
  generationReport: z.unknown().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const proposalSectionSchema = z.object({
  id: z.string(),
  sectionKey: z.string(),
  title: z.string(),
  content: z.string(),
  sources: z.unknown(),
  version: z.number(),
  updatedAt: z.string(),
});
export type ProposalSection = z.infer<typeof proposalSectionSchema>;

export const REQUIREMENT_MAPPING_KINDS = ["capability", "experience", "document", "signer"] as const;
export type RequirementMappingKind = (typeof REQUIREMENT_MAPPING_KINDS)[number];

// --- checklist de integridad (E8) -----------------------------------------------
export const COMPLIANCE_RESULTS = ["verde", "ambar", "rojo"] as const;
export type ComplianceResult = (typeof COMPLIANCE_RESULTS)[number];

export const complianceItemSchema = z.object({
  id: z.string(),
  dimension: z.string().nullable(),
  result: z.enum(COMPLIANCE_RESULTS).nullable(),
  label: z.string(),
  notes: z.string().nullable(),
  evidenceRef: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type ComplianceItem = z.infer<typeof complianceItemSchema>;

export const checklistReportSchema = z.object({
  overallStatus: z.enum(COMPLIANCE_RESULTS),
  items: z.array(complianceItemSchema),
});
export type ChecklistReport = z.infer<typeof checklistReportSchema>;

// --- aprobación (E8) -------------------------------------------------------------
export const approvalSchema = z.object({
  scope: z.string(),
  scopeRef: z.string(),
  approvedBy: z.string().nullable(),
  approvedByRole: z.string(),
  approvedAt: z.string(),
  inputsHash: z.string(),
  status: z.enum(["vigente", "invalidada"]),
});
export type Approval = z.infer<typeof approvalSchema>;

export const commentSchema = z.object({
  scopeRef: z.string(),
  authorId: z.string().nullable(),
  authorRole: z.string(),
  text: z.string(),
  createdAt: z.string(),
});
export type ApprovalComment = z.infer<typeof commentSchema>;

export const approvalStateSchema = z.object({
  state: z.enum(["borrador", "en_revision", "aprobado"]),
  approvals: z.array(approvalSchema),
  comments: z.array(commentSchema),
  currentInputsHash: z.string(),
  fullyApproved: z.boolean(),
});
export type ApprovalState = z.infer<typeof approvalStateSchema>;

export const APPROVER_ROLES: OrgRole[] = ["owner", "admin", "reviewer"];

// --- paquete final (E8/E9) -------------------------------------------------------
export const packageAssembleResponseSchema = z.object({
  id: z.string(),
  status: z.enum(["draft", "ready"]),
  draftReasons: z.array(z.string()),
  missing: z.array(z.string()),
  generatedAt: z.string(),
  notice: z.string(),
});
export type PackageAssembleResponse = z.infer<typeof packageAssembleResponseSchema>;

// --- checklist de "sala de guerra" (REQ-040) --------------------------------------
export const WAR_ROOM_DIMENSIONS = ["checklist_anti_desechamiento", "cuenta_regresiva", "hash_zip", "holgura_24h"] as const;
export type WarRoomDimension = (typeof WAR_ROOM_DIMENSIONS)[number];

export const warRoomItemSchema = z.object({
  dimension: z.enum(WAR_ROOM_DIMENSIONS),
  status: z.enum(COMPLIANCE_RESULTS),
  detail: z.string(),
  evidence: z.array(z.string()),
});
export type WarRoomItem = z.infer<typeof warRoomItemSchema>;

export const warRoomReportSchema = z.object({
  id: z.string(),
  overallStatus: z.enum(COMPLIANCE_RESULTS),
  items: z.array(warRoomItemSchema),
  hoursUntilDeadline: z.number().nullable(),
  submissionDeadlineIso: z.string().nullable(),
  computedAt: z.string(),
  runBy: z.string().nullable(),
});
export type WarRoomReport = z.infer<typeof warRoomReportSchema>;

// --- presentación declarada por el usuario (E9, A15) ----------------------------
export const submissionSchema = z.object({
  id: z.string(),
  status: z.string(),
  submittedAt: z.string().nullable(),
  acknowledgementStorageRef: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type Submission = z.infer<typeof submissionSchema>;

// --- post-adjudicación (E11) ------------------------------------------------------
// Ronda 5 (apps/api): kinds ampliados (garantía con tipo, facturación con
// CFDI, penalización/convenio modificatorio) -- ver
// apps/api/src/modules/expediente/schemas.ts (docstring sobre qué campo
// aplica a cada kind).
export const FOLLOWUP_KINDS = ["hito", "garantia", "facturacion", "pago", "penalizacion", "convenio_modificatorio", "otro"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export const FOLLOWUP_STATUSES = ["pending", "in_progress", "done", "overdue", "cancelled"] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

export const ALERT_LEVELS = ["vencido", "proximo"] as const;
export type AlertLevel = (typeof ALERT_LEVELS)[number];

export const legalRegimeSchema = z.object({
  law: z.string(),
  article: z.string(),
  dofDate: z.string(),
  effectiveDate: z.string(),
  unit: z.enum(["dias_habiles", "dias_naturales"]),
  days: z.number(),
  reason: z.string(),
});
export type LegalRegime = z.infer<typeof legalRegimeSchema>;

export const followupSchema = z.object({
  id: z.string(),
  tenderId: z.string(),
  kind: z.string(),
  label: z.string(),
  dueDate: z.string().nullable(),
  status: z.string(),
  amount: z.number().nullable(),
  notes: z.string().nullable(),
  legalReference: z.string().nullable(),
  reminderLeadDays: z.number(),
  jobId: z.string().nullable(),
  createdAt: z.string(),
  responsibleParty: z.string().nullable().optional(),
  guaranteeType: z.string().nullable().optional(),
  cfdiReference: z.string().nullable().optional(),
  acceptanceDate: z.string().nullable().optional(),
  modificationReference: z.string().nullable().optional(),
  calendarNote: z.string().nullable(),
  legalRegime: legalRegimeSchema.nullable(),
  /** REQ-056: 'vencido' (ya pasó dueDate, no terminal) | 'proximo' (vence dentro de reminderLeadDays) | null. */
  alertLevel: z.enum(ALERT_LEVELS).nullable().optional(),
});
export type Followup = z.infer<typeof followupSchema>;

// --- aviso de privacidad (REQ-119/131, GET /legal/privacy-notice) --------------
export const privacyNoticeSchema = z.object({
  version: z.number(),
  publishedAt: z.string(),
  status: z.literal("borrador_pendiente_validacion_juridica"),
  responsible: z.string(),
  supervisoryAuthority: z.string(),
  applicableLaw: z.string(),
  sourceDocument: z.string(),
  contentMarkdown: z.string(),
});
export type PrivacyNotice = z.infer<typeof privacyNoticeSchema>;

// --- 2FA / step-up TOTP (REQ-044/064, /auth/2fa/*) ------------------------------
export const stepUpStatusSchema = z.object({
  enrolled: z.boolean(),
  enrolledAt: z.string().nullable(),
});
export type StepUpStatus = z.infer<typeof stepUpStatusSchema>;

export const enrollTwoFactorResponseSchema = z.object({
  secretBase32: z.string(),
  otpauthUrl: z.string(),
  backupCodes: z.array(z.string()),
});
export type EnrollTwoFactorResponse = z.infer<typeof enrollTwoFactorResponseSchema>;

export const verifyEnrollmentResponseSchema = z.object({
  enrolled: z.literal(true),
  stepUpToken: z.string(),
  expiresAt: z.string(),
});
export type VerifyEnrollmentResponse = z.infer<typeof verifyEnrollmentResponseSchema>;

export const stepUpResponseSchema = z.object({
  stepUpToken: z.string(),
  expiresAt: z.string(),
});
export type StepUpResponse = z.infer<typeof stepUpResponseSchema>;

// --- E21 (docs/BACKLOG.md): desactivar 2FA / regenerar códigos de respaldo,
// ambos con step-up -- POST /auth/2fa/disable, POST
// /auth/2fa/backup-codes/regenerate (apps/api/src/modules/twofa/routes.ts).
export const disableTwoFactorResponseSchema = z.object({ disabled: z.literal(true) });
export type DisableTwoFactorResponse = z.infer<typeof disableTwoFactorResponseSchema>;

export const regenerateBackupCodesResponseSchema = z.object({ backupCodes: z.array(z.string()) });
export type RegenerateBackupCodesResponse = z.infer<typeof regenerateBackupCodesResponseSchema>;

// --- E21 (docs/BACKLOG.md): sesiones activas propias (refresh tokens) --
// GET/DELETE /auth/sessions, POST /auth/sessions/revoke-others
// (apps/api/src/modules/auth/sessions.routes.ts).
export const authSessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export type AuthSession = z.infer<typeof authSessionSchema>;

export const authSessionsListSchema = z.object({ sessions: z.array(authSessionSchema) });
export type AuthSessionsList = z.infer<typeof authSessionsListSchema>;

export const revokeSessionResponseSchema = z.object({ revoked: z.literal(true) });
export type RevokeSessionResponse = z.infer<typeof revokeSessionResponseSchema>;

export const revokeOtherSessionsResponseSchema = z.object({ revokedCount: z.number().int().nonnegative() });
export type RevokeOtherSessionsResponse = z.infer<typeof revokeOtherSessionsResponseSchema>;

// --- E21 (docs/BACKLOG.md): cambiar contraseña propia con step-up --
// POST /auth/password/change (apps/api/src/modules/auth/password.routes.ts).
export const changePasswordResponseSchema = z.object({ changed: z.literal(true) });
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

// --- E19 (docs/BACKLOG.md): desvincular Google con step-up --
// POST /auth/google/unlink (apps/api/src/modules/auth/google/unlink.routes.ts).
export const unlinkGoogleResponseSchema = z.object({ unlinked: z.literal(true) });
export type UnlinkGoogleResponse = z.infer<typeof unlinkGoogleResponseSchema>;

// --- Patrón Likida/atiende.ai #7 (onboarding conversacional) --
// GET /onboarding/state (apps/api/src/modules/onboarding/routes.ts).
const onboardingFieldIdSchema = z.enum(["organization", "legalName", "taxId", "sector", "team", "document"]);
export type OnboardingFieldId = z.infer<typeof onboardingFieldIdSchema>;

export const onboardingStateSchema = z.object({
  // `z.string()` sin `.uuid()` -- mismo criterio que myOrgSchema.id de
  // arriba: los ids reales de apps/api SÍ son UUID, pero exigirlo aquí
  // rompería contra fixtures de prueba que usan ids legibles ("org-a").
  orgId: z.string().nullable(),
  hasOrganization: z.boolean(),
  legalName: z.string().nullable(),
  taxId: z.string().nullable(),
  sector: z.string().nullable(),
  teamInvited: z.boolean(),
  firstDocumentUploaded: z.boolean(),
  missingRequired: z.array(onboardingFieldIdSchema),
  missingOptional: z.array(onboardingFieldIdSchema),
  isComplete: z.boolean(),
  nextField: onboardingFieldIdSchema.nullable(),
  question: z.string(),
  questionSource: z.enum(["llm", "canned"]),
  nextAction: z
    .object({ method: z.enum(["GET", "POST", "PUT"]), path: z.string(), hint: z.string() })
    .nullable(),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;
