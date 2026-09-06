import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import * as api from "@/lib/api/company";

/**
 * Todos los hooks de este módulo dependen de `currentOrgId` (header
 * `X-Org-Id`, ver hooks/useAuth.tsx): mientras no haya organización
 * seleccionada, las queries quedan `enabled: false` (ni loading ni error,
 * simplemente no se disparan) — la UI debe mostrar su propio mensaje si
 * `currentOrgId` es null (ver páginas de empresa).
 */

export function useCompanyProfile() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["company", "profile", currentOrgId],
    queryFn: () => api.getCompanyProfile(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}

export function useSaveCompanyProfile() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.CompanyProfileInput) => api.saveCompanyProfile(currentOrgId!, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["company", "profile", currentOrgId] });
    },
  });
}

export function useCapabilities() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["company", "capabilities", currentOrgId],
    queryFn: () => api.listCapabilities(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}

export function useCreateCapability() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.CapabilityInput) => api.createCapability(currentOrgId!, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["company", "capabilities", currentOrgId] }),
  });
}

export function useDeleteCapability() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteCapability(currentOrgId!, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["company", "capabilities", currentOrgId] }),
  });
}

export function useSignatories() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["company", "signatories", currentOrgId],
    queryFn: () => api.listSignatories(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}

export function useCreateSignatory() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.SignatoryInput) => api.createSignatory(currentOrgId!, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["company", "signatories", currentOrgId] }),
  });
}

export function useDeleteSignatory() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteSignatory(currentOrgId!, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["company", "signatories", currentOrgId] }),
  });
}

export function useDocuments() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["company", "documents", currentOrgId],
    queryFn: () => api.listDocuments(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}

export function useUploadDocument() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.DocumentInput) => api.uploadDocument(currentOrgId!, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["company", "documents", currentOrgId] }),
  });
}

export function useDeleteDocument() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteDocument(currentOrgId!, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["company", "documents", currentOrgId] }),
  });
}

export function useRates() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["company", "rates", currentOrgId],
    queryFn: () => api.listRates(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}

export function useProposeRate() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.RateInput) => api.proposeRate(currentOrgId!, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["company", "rates", currentOrgId] }),
  });
}

export function useApproveRate() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.approveRate(currentOrgId!, id),
    // WI-04 (docs/auditoria-2/web-integrado.md): `onSettled` async + `await`
    // mantiene `isPending` en `true` hasta que el refetch de
    // ["company","rates",currentOrgId] termina de traer el estado real
    // (react-query espera cualquier Promise devuelta por `onSettled` antes
    // de asentar la mutación) — sin esto, `isPending` volvía a `false` en
    // cuanto la petición HTTP resolvía (con éxito O CON ERROR), mientras la
    // fila todavía mostraba `status: "draft"` (dato aún no refrescado): una
    // ventana real en la que un segundo clic (Aprobar de nuevo, o Rechazar)
    // podía dispararse contra la misma tarifa ya decidida. `onSettled` (no
    // solo `onSuccess`) porque un 409 real de la API (alguien más decidió
    // primero) también significa que el estado en caché ya está obsoleto —
    // hay que refrescarlo igual para que la fila deje de mostrar acciones
    // sobre un estado que ya no existe.
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["company", "rates", currentOrgId] });
    },
  });
}

export function useRejectRate() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.rejectRate(currentOrgId!, id),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["company", "rates", currentOrgId] });
    },
  });
}

/**
 * Solo lectura (ronda 5): usada como selector de fuente al mapear la
 * propuesta técnica en Redacción (kind="experience" de
 * `POST .../proposal/technical/generate`). apps/api expone CRUD completo en
 * `/company/experience`, pero esta ronda no agrega una pantalla propia de
 * gestión de experiencia -- fuera del alcance despachado.
 */
export function useExperience() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["company", "experience", currentOrgId],
    queryFn: () => api.listExperience(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}
