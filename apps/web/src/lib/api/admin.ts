// Back office / superadmin (E10). Todas estas rutas están gateadas en la API
// por `app.requireSuperadmin` — nunca por membresía de organización (ver
// apps/api/src/plugins/superadmin.plugin.ts). Un usuario normal recibe 403
// con el mismo `application/problem+json` que cualquier otra ruta, y la UI
// lo muestra tal cual (ver hooks/useAdmin.ts) en vez de ocultar el enlace de
// navegación como única barrera.
import { apiRequest } from "./client";
import {
  adminOrgSchema,
  adminConnectorFreshnessSchema,
  adminJobSchema,
  adminCostByOrgSchema,
  incidentSchema,
  pendingApprovalSchema,
  type AdminOrg,
  type AdminConnectorFreshness,
  type AdminJob,
  type AdminCostByOrg,
  type Incident,
  type PendingApproval,
} from "./schemas";
import { z } from "zod";

export async function listAdminOrganizations(): Promise<AdminOrg[]> {
  const raw = await apiRequest<unknown>("/admin/organizations");
  return z.array(adminOrgSchema).parse(raw);
}

export async function listAdminConnectorFreshness(): Promise<AdminConnectorFreshness[]> {
  const raw = await apiRequest<unknown>("/admin/connectors/freshness");
  return z.array(adminConnectorFreshnessSchema).parse(raw);
}

export async function listAdminJobs(status?: string): Promise<AdminJob[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const raw = await apiRequest<unknown>(`/admin/jobs${query}`);
  return z.array(adminJobSchema).parse(raw);
}

export async function retryAdminJob(id: string): Promise<AdminJob> {
  const raw = await apiRequest<unknown>(`/admin/jobs/${id}/retry`, { method: "POST" });
  return adminJobSchema.parse(raw);
}

export async function listAdminCosts(): Promise<AdminCostByOrg[]> {
  const raw = await apiRequest<unknown>("/admin/costs");
  return z.array(adminCostByOrgSchema).parse(raw);
}

export async function listAdminIncidents(): Promise<Incident[]> {
  const raw = await apiRequest<unknown>("/admin/incidents");
  return z.array(incidentSchema).parse(raw);
}

export interface IncidentInput {
  title: string;
  description?: string;
  severity?: "low" | "medium" | "high" | "critical";
  orgId?: string;
}

export async function createAdminIncident(input: IncidentInput): Promise<Incident> {
  const raw = await apiRequest<unknown>("/admin/incidents", { method: "POST", body: input });
  return incidentSchema.parse(raw);
}

export async function resolveAdminIncident(id: string): Promise<Incident> {
  const raw = await apiRequest<unknown>(`/admin/incidents/${id}/resolve`, { method: "POST" });
  return incidentSchema.parse(raw);
}

export async function listAdminApprovals(): Promise<PendingApproval[]> {
  const raw = await apiRequest<unknown>("/admin/approvals");
  return z.array(pendingApprovalSchema).parse(raw);
}
