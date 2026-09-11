// Cliente hacia las 26 rutas de `apps/api` bajo
// `/expediente/tenders/:tenderId/...` (documentos+matriz, propuesta,
// checklist, aprobación, paquete, presentación, post-adjudicación — ver
// apps/api/README.md módulo "expediente" y
// apps/api/src/modules/expediente/schemas.ts, fuente de verdad de estos
// esquemas). Todas requieren `X-Org-Id` (organización activa).
import { z } from "zod";
import { apiRequest } from "./client";
import { ApiError } from "./http";
import {
  tenderDocumentSchema,
  requirementItemSchema,
  requirementConflictSchema,
  matrixBuildResponseSchema,
  proposalSchema,
  proposalSectionSchema,
  checklistReportSchema,
  approvalStateSchema,
  packageAssembleResponseSchema,
  warRoomReportSchema,
  submissionSchema,
  followupSchema,
  type TenderDocument,
  type RequirementItem,
  type RequirementConflict,
  type MatrixBuildResponse,
  type Proposal,
  type ProposalSection,
  type ChecklistReport,
  type ApprovalState,
  type PackageAssembleResponse,
  type WarRoomReport,
  type Submission,
  type Followup,
  type DocumentKind,
  type RequirementMappingKind,
} from "./schemas";

const base = (tenderId: string) => `/expediente/tenders/${tenderId}`;

// --- documentos + matriz de requisitos (E6) -------------------------------------
export interface DocumentUploadInput {
  documentKind: DocumentKind;
  filename: string;
  mimeType?: string;
  contentBase64: string;
}

export async function listTenderDocuments(orgId: string, tenderId: string): Promise<TenderDocument[]> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/documents`, { orgId });
  return z.array(tenderDocumentSchema).parse(raw);
}

export async function uploadTenderDocument(orgId: string, tenderId: string, input: DocumentUploadInput): Promise<TenderDocument> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/documents`, { method: "POST", body: input, orgId });
  return tenderDocumentSchema.parse(raw);
}

export async function buildRequirementMatrix(orgId: string, tenderId: string): Promise<MatrixBuildResponse> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/matrix/build`, { method: "POST", orgId });
  return matrixBuildResponseSchema.parse(raw);
}

export async function listRequirementMatrix(orgId: string, tenderId: string, includeHistory = false): Promise<RequirementItem[]> {
  const query = includeHistory ? "?includeHistory=true" : "";
  const raw = await apiRequest<unknown>(`${base(tenderId)}/matrix${query}`, { orgId });
  return z.array(requirementItemSchema).parse(raw);
}

export interface RequirementUpdateInput {
  matrixStatus?: RequirementItem["matrixStatus"];
  assignedTo?: string | null;
}

export async function updateRequirementItem(orgId: string, tenderId: string, id: string, input: RequirementUpdateInput): Promise<RequirementItem> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/matrix/${id}`, { method: "PATCH", body: input, orgId });
  return requirementItemSchema.parse(raw);
}

export async function listRequirementConflicts(orgId: string, tenderId: string): Promise<RequirementConflict[]> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/conflicts`, { orgId });
  return z.array(requirementConflictSchema).parse(raw);
}

export async function resolveRequirementConflict(orgId: string, tenderId: string, id: string, resolutionNotes: string): Promise<RequirementConflict> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/conflicts/${id}/resolve`, { method: "POST", body: { resolutionNotes }, orgId });
  return requirementConflictSchema.parse(raw);
}

// --- propuesta técnica/económica (E7) -------------------------------------------
export async function getProposal(orgId: string, tenderId: string): Promise<Proposal> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/proposal`, { orgId });
  return proposalSchema.parse(raw);
}

export async function listProposalSections(orgId: string, tenderId: string): Promise<ProposalSection[]> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/proposal/sections`, { orgId });
  return z.array(proposalSectionSchema).parse(raw);
}

export async function updateProposalSection(orgId: string, tenderId: string, sectionKey: string, content: string): Promise<ProposalSection> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/proposal/sections/${encodeURIComponent(sectionKey)}`, {
    method: "PATCH",
    body: { content },
    orgId,
  });
  return proposalSectionSchema.parse(raw);
}

export interface RequirementMappingInput {
  requirementId: string;
  kind: RequirementMappingKind;
  refKey: string;
}

export async function generateTechnicalProposal(
  orgId: string,
  tenderId: string,
  mappings: RequirementMappingInput[],
  conditionEvaluations: Record<string, boolean> = {},
): Promise<Proposal> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/proposal/technical/generate`, {
    method: "POST",
    body: { mappings, conditionEvaluations },
    orgId,
  });
  return proposalSchema.parse(raw);
}

export interface EconomicLineItemInput {
  requirementId?: string;
  concept: string;
  quantity: number;
}

export async function generateEconomicProposal(orgId: string, tenderId: string, lineItems: EconomicLineItemInput[]): Promise<Proposal> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/proposal/economic/generate`, { method: "POST", body: { lineItems }, orgId });
  return proposalSchema.parse(raw);
}

// --- checklist de integridad (E8) -----------------------------------------------
export async function getChecklist(orgId: string, tenderId: string): Promise<ChecklistReport> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/checklist`, { orgId });
  return checklistReportSchema.parse(raw);
}

export interface ChecklistRunInput {
  files?: { filename: string; extension: string; sizeBytes: number; pages?: number }[];
  requiredSignatures?: { role: string; userConfirmedSigned: boolean }[];
  presentAnnexRefs?: string[];
}

export async function runChecklist(orgId: string, tenderId: string, input: ChecklistRunInput): Promise<ChecklistReport> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/checklist/run`, { method: "POST", body: input, orgId });
  return checklistReportSchema.parse(raw);
}

// --- aprobación (E8) -------------------------------------------------------------
export async function getApprovalState(orgId: string, tenderId: string): Promise<ApprovalState> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/approval`, { orgId });
  return approvalStateSchema.parse(raw);
}

export async function requestApprovalReview(orgId: string, tenderId: string, scopeRef = "expediente"): Promise<ApprovalState> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/approval/request-review`, { method: "POST", body: { scopeRef }, orgId });
  return approvalStateSchema.parse(raw);
}

/**
 * Ronda 5 (REQ-044/064): exige `stepUpToken` de una sesión de step-up
 * vigente (`POST /auth/2fa/step-up`) — sin 2FA enrolado y verificado,
 * apps/api responde 403 con instrucción explícita antes de siquiera llegar
 * a esta ruta.
 */
export async function approveExpediente(
  orgId: string,
  tenderId: string,
  stepUpToken: string,
  scope: "seccion" | "documento" | "expediente" = "expediente",
  scopeRef = "expediente",
): Promise<ApprovalState> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/approval/approve`, { method: "POST", body: { scope, scopeRef }, orgId, stepUpToken });
  return approvalStateSchema.parse(raw);
}

export async function addApprovalComment(orgId: string, tenderId: string, text: string, scopeRef = "expediente"): Promise<ApprovalState> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/approval/comments`, { method: "POST", body: { scopeRef, text }, orgId });
  return approvalStateSchema.parse(raw);
}

// --- paquete final (E8/E9) -------------------------------------------------------
export async function assemblePackage(orgId: string, tenderId: string): Promise<PackageAssembleResponse> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/package/assemble`, { method: "POST", orgId });
  return packageAssembleResponseSchema.parse(raw);
}

export async function getLatestPackage(orgId: string, tenderId: string): Promise<PackageAssembleResponse | null> {
  try {
    const raw = await apiRequest<unknown>(`${base(tenderId)}/package/latest`, { orgId });
    return packageAssembleResponseSchema.parse(raw);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// --- checklist de "sala de guerra" (REQ-040) --------------------------------------
export async function getLatestWarRoomChecklist(orgId: string, tenderId: string): Promise<WarRoomReport | null> {
  try {
    const raw = await apiRequest<unknown>(`${base(tenderId)}/war-room`, { orgId });
    return warRoomReportSchema.parse(raw);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function runWarRoomChecklist(orgId: string, tenderId: string): Promise<WarRoomReport> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/war-room/run`, { method: "POST", orgId });
  return warRoomReportSchema.parse(raw);
}

/**
 * Descarga autenticada del ZIP del paquete (`apiRequest` no sirve aquí: la
 * respuesta no es JSON). Reconstruye manualmente la autenticación con
 * `X-Org-Id`/`Authorization` — el propio archivo del cliente HTTP
 * (`client.ts`) documenta por qué `apiRequest` solo maneja JSON. Un 409
 * (paquete "ready" desactualizado, ver AE-14) se propaga como error real
 * para que la UI lo muestre en vez de descargar un ZIP obsoleto.
 */
export async function downloadPackage(orgId: string, tenderId: string, accessToken: string): Promise<Blob> {
  const API_URL = import.meta.env.VITE_API_URL ?? "";
  const response = await fetch(`${API_URL}${base(tenderId)}/package/download`, {
    headers: { Authorization: `Bearer ${accessToken}`, "X-Org-Id": orgId },
  });
  if (!response.ok) {
    let detail = response.statusText;
    let requestId: string | undefined;
    try {
      const problem = (await response.json()) as { title?: string; requestId?: string };
      detail = problem.title ?? detail;
      requestId = problem.requestId;
    } catch {
      // cuerpo no era JSON
    }
    throw new ApiError(detail || `Error ${response.status}`, response.status, { requestId });
  }
  return response.blob();
}

// --- presentación declarada por el usuario (E9, A15) ----------------------------
export async function getSubmission(orgId: string, tenderId: string): Promise<Submission | null> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/submission`, { orgId });
  return submissionSchema.nullable().parse(raw);
}

export interface SubmissionDeclareInput {
  submittedAt: string;
  acknowledgementFilename?: string;
  acknowledgementContentBase64?: string;
  notes?: string;
}

export async function declareSubmission(orgId: string, tenderId: string, input: SubmissionDeclareInput): Promise<Submission> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/submission/declare`, { method: "POST", body: input, orgId });
  return submissionSchema.parse(raw);
}

// --- post-adjudicación (E11) ------------------------------------------------------
export async function listPostAward(orgId: string, tenderId: string): Promise<Followup[]> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/post-award`, { orgId });
  return z.array(followupSchema).parse(raw);
}

/**
 * REQ-056: alertas de vencimiento a través de TODAS las convocatorias de la
 * organización activa (no por tenderId -- ruta `/expediente/post-award-alerts`,
 * distinta de `/expediente/tenders/:tenderId/post-award`).
 */
export async function listPostAwardAlerts(orgId: string): Promise<Followup[]> {
  const raw = await apiRequest<unknown>("/expediente/post-award-alerts", { orgId });
  return z.array(followupSchema).parse(raw);
}

export interface FollowupCreateInput {
  kind: Followup["kind"];
  label: string;
  dueDate?: string;
  amount?: number;
  notes?: string;
  reminderLeadDays?: number;
  invoiceVerifiedOn?: string;
  holidays?: string[];
  /** kind='hito' */
  responsibleParty?: string;
  /** kind='garantia' */
  guaranteeType?: string;
  /** kind='facturacion' */
  cfdiReference?: string;
  /** kind='facturacion': dispara el mismo cómputo legal de plazo que invoiceVerifiedOn. */
  acceptanceDate?: string;
  /** kind='penalizacion' | 'convenio_modificatorio' */
  modificationReference?: string;
}

export async function createPostAward(orgId: string, tenderId: string, input: FollowupCreateInput): Promise<Followup> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/post-award`, { method: "POST", body: input, orgId });
  return followupSchema.parse(raw);
}

export interface FollowupUpdateInput {
  status?: Followup["status"];
  notes?: string;
  dueDate?: string | null;
}

export async function updatePostAward(orgId: string, tenderId: string, id: string, input: FollowupUpdateInput): Promise<Followup> {
  const raw = await apiRequest<unknown>(`${base(tenderId)}/post-award/${id}`, { method: "PATCH", body: input, orgId });
  return followupSchema.parse(raw);
}
