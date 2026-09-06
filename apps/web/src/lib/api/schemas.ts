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

export const userPublicSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
});
export type UserPublic = z.infer<typeof userPublicSchema>;

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
