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
  auditLogListResponseSchema,
  toolCallSchema,
  type AdminOrg,
  type AdminConnectorFreshness,
  type AdminJob,
  type AdminCostByOrg,
  type Incident,
  type PendingApproval,
  type AuditLogListResponse,
  type ToolCall,
} from "./schemas";
import type { AuditLogFilters } from "./audit";
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

// --- ronda 4: aprobación cross-org de tool_calls (sin X-Org-Id: la
// organización afectada se resuelve de la propia fila `tool_calls.org_id`
// en apps/api, nunca de un header) ------------------------------------------
export async function approveAdminToolCall(id: string): Promise<ToolCall> {
  const raw = await apiRequest<unknown>(`/admin/tool-calls/${id}/approve`, { method: "POST" });
  return toolCallSchema.parse(raw);
}

export async function denyAdminToolCall(id: string): Promise<ToolCall> {
  const raw = await apiRequest<unknown>(`/admin/tool-calls/${id}/deny`, { method: "POST" });
  return toolCallSchema.parse(raw);
}

// --- ronda 4: bitácora de auditoría de TODAS las organizaciones ------------------
export interface AdminAuditLogFilters extends AuditLogFilters {
  orgId?: string;
}

function toAdminAuditQueryString(filters: AdminAuditLogFilters): string {
  const params = new URLSearchParams();
  if (filters.orgId) params.set("orgId", filters.orgId);
  if (filters.entity) params.set("entity", filters.entity);
  if (filters.actorId) params.set("actorId", filters.actorId);
  if (filters.correlationId) params.set("correlationId", filters.correlationId);
  if (filters.createdFrom) params.set("createdFrom", filters.createdFrom);
  if (filters.createdTo) params.set("createdTo", filters.createdTo);
  if (filters.cursor) params.set("cursor", filters.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function listAdminAuditLog(filters: AdminAuditLogFilters = {}): Promise<AuditLogListResponse> {
  const raw = await apiRequest<unknown>(`/admin/audit-log${toAdminAuditQueryString(filters)}`);
  return auditLogListResponseSchema.parse(raw);
}
