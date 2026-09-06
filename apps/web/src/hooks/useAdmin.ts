// Hooks del back office / superadmin (E10). No dependen de `currentOrgId`
// (el header `X-Org-Id` es irrelevante para estas rutas: están gateadas por
// `app.requireSuperadmin`, ver apps/api/src/plugins/superadmin.plugin.ts).
// Un usuario normal recibe 403 real de la API: `isError`/`error` de
// react-query trae ese `ApiError` tal cual, y las páginas lo muestran con
// `<ErrorState/>` en vez de ocultar la ruta (permisos derivados del rol NUNCA
// como única barrera).
//
// Ronda 5: `enabled: status === "authenticated"` en cada lectura -- sin
// esto, la query dispara en el primer render, ANTES de que `AuthProvider`
// termine de rotar el refresh token guardado y consiga un access token
// real (ver useAuth.tsx). En producción el `retry: 1` por defecto de
// `queryClient` disimulaba la carrera (el segundo intento sí encontraba el
// token ya listo), pero seguía siendo una petición real de más, y un
// `retry: false` (como en pruebas de componente) la deja fallando con "No
// hay una sesión activa" de forma permanente y visible.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import * as api from "@/lib/api/admin";

export function useAdminOrganizations() {
  const { status } = useAuth();
  return useQuery({ queryKey: ["admin", "organizations"], queryFn: api.listAdminOrganizations, enabled: status === "authenticated" });
}

export function useAdminConnectorFreshness() {
  const { status } = useAuth();
  return useQuery({ queryKey: ["admin", "connectors-freshness"], queryFn: api.listAdminConnectorFreshness, enabled: status === "authenticated" });
}

export function useAdminJobs(status?: string) {
  const { status: authStatus } = useAuth();
  return useQuery({ queryKey: ["admin", "jobs", status ?? "all"], queryFn: () => api.listAdminJobs(status), enabled: authStatus === "authenticated" });
}

export function useRetryAdminJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.retryAdminJob(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] }),
  });
}

export function useAdminCosts() {
  const { status } = useAuth();
  return useQuery({ queryKey: ["admin", "costs"], queryFn: api.listAdminCosts, enabled: status === "authenticated" });
}

export function useAdminIncidents() {
  const { status } = useAuth();
  return useQuery({ queryKey: ["admin", "incidents"], queryFn: api.listAdminIncidents, enabled: status === "authenticated" });
}

export function useCreateAdminIncident() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.IncidentInput) => api.createAdminIncident(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin", "incidents"] }),
  });
}

export function useResolveAdminIncident() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.resolveAdminIncident(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin", "incidents"] }),
  });
}

export function useAdminApprovals() {
  const { status } = useAuth();
  return useQuery({ queryKey: ["admin", "approvals"], queryFn: api.listAdminApprovals, enabled: status === "authenticated" });
}

// Ronda 5: aprobación cross-org real de tool_calls (antes esta pantalla era
// de solo lectura -- ver docstring de AprobacionesBackofficePage.tsx).
export function useApproveAdminToolCall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.approveAdminToolCall(id),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "approvals"] });
    },
  });
}

export function useDenyAdminToolCall() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.denyAdminToolCall(id),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ["admin", "approvals"] });
    },
  });
}

export function useAdminAuditLog(filters: api.AdminAuditLogFilters = {}) {
  const { status } = useAuth();
  return useQuery({
    queryKey: ["admin", "audit-log", filters],
    queryFn: () => api.listAdminAuditLog(filters),
    enabled: status === "authenticated",
  });
}
