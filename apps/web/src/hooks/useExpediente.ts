// Hooks del expediente de participación (E6-E9/E11) sobre las 26 rutas de
// apps/api bajo /expediente/tenders/:tenderId/... (ver
// src/lib/api/expediente.ts). Todos dependen de `currentOrgId` (X-Org-Id) Y
// de un `tenderId` concreto -- mientras falte cualquiera de los dos, la
// query queda `enabled: false` y la página debe mostrar su propio mensaje
// (mismo patrón que useGoNoGo.ts/useMatching.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import * as api from "@/lib/api/expediente";

function key(orgId: string | null, tenderId: string | null | undefined, ...rest: (string | undefined)[]) {
  return ["expediente", orgId, tenderId, ...rest];
}

// --- documentos + matriz ---------------------------------------------------
export function useTenderDocuments(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "documents"),
    queryFn: () => api.listTenderDocuments(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

export function useUploadTenderDocument(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.DocumentUploadInput) => api.uploadTenderDocument(currentOrgId!, tenderId!, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "documents") }),
  });
}

export function useRequirementMatrix(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "matrix"),
    queryFn: () => api.listRequirementMatrix(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

export function useBuildRequirementMatrix(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.buildRequirementMatrix(currentOrgId!, tenderId!),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId) }),
  });
}

export function useUpdateRequirementItem(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: api.RequirementUpdateInput }) => api.updateRequirementItem(currentOrgId!, tenderId!, id, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "matrix") }),
  });
}

export function useRequirementConflicts(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "conflicts"),
    queryFn: () => api.listRequirementConflicts(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

export function useResolveConflict(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolutionNotes }: { id: string; resolutionNotes: string }) => api.resolveRequirementConflict(currentOrgId!, tenderId!, id, resolutionNotes),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "conflicts") }),
  });
}

// --- propuesta técnica/económica -------------------------------------------
export function useProposal(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "proposal"),
    queryFn: () => api.getProposal(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

export function useProposalSections(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "sections"),
    queryFn: () => api.listProposalSections(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

function invalidateProposalGroup(queryClient: ReturnType<typeof useQueryClient>, currentOrgId: string | null, tenderId: string | null | undefined) {
  void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "proposal") });
  void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "sections") });
  void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "approval") });
  void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "checklist") });
  void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "package") });
}

export function useUpdateProposalSection(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sectionKey, content }: { sectionKey: string; content: string }) => api.updateProposalSection(currentOrgId!, tenderId!, sectionKey, content),
    onSuccess: () => invalidateProposalGroup(queryClient, currentOrgId, tenderId),
  });
}

export function useGenerateTechnicalProposal(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ mappings, conditionEvaluations }: { mappings: api.RequirementMappingInput[]; conditionEvaluations?: Record<string, boolean> }) =>
      api.generateTechnicalProposal(currentOrgId!, tenderId!, mappings, conditionEvaluations),
    onSuccess: () => invalidateProposalGroup(queryClient, currentOrgId, tenderId),
  });
}

export function useGenerateEconomicProposal(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lineItems: api.EconomicLineItemInput[]) => api.generateEconomicProposal(currentOrgId!, tenderId!, lineItems),
    onSuccess: () => invalidateProposalGroup(queryClient, currentOrgId, tenderId),
  });
}

// --- checklist de integridad -------------------------------------------------
export function useChecklist(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "checklist"),
    queryFn: () => api.getChecklist(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

export function useRunChecklist(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.ChecklistRunInput) => api.runChecklist(currentOrgId!, tenderId!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "checklist") });
      void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "package") });
    },
  });
}

// --- aprobación ---------------------------------------------------------------
export function useApprovalState(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "approval"),
    queryFn: () => api.getApprovalState(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

export function useRequestApprovalReview(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (scopeRef?: string) => api.requestApprovalReview(currentOrgId!, tenderId!, scopeRef),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "approval") }),
  });
}

export function useApproveExpediente(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stepUpToken: string) => api.approveExpediente(currentOrgId!, tenderId!, stepUpToken),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "approval") });
      void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "package") });
    },
  });
}

export function useAddApprovalComment(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (text: string) => api.addApprovalComment(currentOrgId!, tenderId!, text),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "approval") }),
  });
}

// --- paquete final --------------------------------------------------------------
export function useLatestPackage(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "package"),
    queryFn: () => api.getLatestPackage(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

export function useAssemblePackage(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.assemblePackage(currentOrgId!, tenderId!),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "package") }),
  });
}

// --- presentación declarada por el usuario --------------------------------------
export function useSubmission(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "submission"),
    queryFn: () => api.getSubmission(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

export function useDeclareSubmission(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.SubmissionDeclareInput) => api.declareSubmission(currentOrgId!, tenderId!, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "submission") }),
  });
}

// --- post-adjudicación -----------------------------------------------------------
export function usePostAward(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: key(currentOrgId, tenderId, "post-award"),
    queryFn: () => api.listPostAward(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId && tenderId),
  });
}

/** REQ-056: alertas de vencimiento de TODAS las convocatorias de la organización activa. */
export function usePostAwardAlerts() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["expediente", currentOrgId, "post-award-alerts"],
    queryFn: () => api.listPostAwardAlerts(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}

export function useCreatePostAward(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.FollowupCreateInput) => api.createPostAward(currentOrgId!, tenderId!, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "post-award") }),
  });
}

export function useUpdatePostAward(tenderId: string | null | undefined) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: api.FollowupUpdateInput }) => api.updatePostAward(currentOrgId!, tenderId!, id, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key(currentOrgId, tenderId, "post-award") }),
  });
}
