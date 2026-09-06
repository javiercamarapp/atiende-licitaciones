// Hooks del back office / superadmin (E10). No dependen de `currentOrgId`
// (el header `X-Org-Id` es irrelevante para estas rutas: están gateadas por
// `app.requireSuperadmin`, ver apps/api/src/plugins/superadmin.plugin.ts).
// Un usuario normal recibe 403 real de la API: `isError`/`error` de
// react-query trae ese `ApiError` tal cual, y las páginas lo muestran con
// `<ErrorState/>` en vez de ocultar la ruta (permisos derivados del rol NUNCA
// como única barrera).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import * as api from "@/lib/api/admin";

export function useAdminOrganizations() {
  return useQuery({ queryKey: ["admin", "organizations"], queryFn: api.listAdminOrganizations });
}

export function useAdminConnectorFreshness() {
  return useQuery({ queryKey: ["admin", "connectors-freshness"], queryFn: api.listAdminConnectorFreshness });
}

export function useAdminJobs(status?: string) {
  return useQuery({ queryKey: ["admin", "jobs", status ?? "all"], queryFn: () => api.listAdminJobs(status) });
}

export function useRetryAdminJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.retryAdminJob(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin", "jobs"] }),
  });
}

export function useAdminCosts() {
  return useQuery({ queryKey: ["admin", "costs"], queryFn: api.listAdminCosts });
}

export function useAdminIncidents() {
  return useQuery({ queryKey: ["admin", "incidents"], queryFn: api.listAdminIncidents });
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
  return useQuery({ queryKey: ["admin", "approvals"], queryFn: api.listAdminApprovals });
}
