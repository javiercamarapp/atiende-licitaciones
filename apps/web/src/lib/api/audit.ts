// Bitácora de auditoría (ronda 4, `GET /audit-log`): append-only, hash
// encadenado (`app.verify_audit_log_chain()`, ver packages/db/README.md).
// Restringido en apps/api a reviewer/admin/owner de la organización activa
// (más estricto que la RLS real, que permite a cualquier rol) — un rol sin
// permiso recibe 403 real, mostrado tal cual por la UI.
import { apiRequest } from "./client";
import { auditLogListResponseSchema, type AuditLogListResponse } from "./schemas";

export interface AuditLogFilters {
  entity?: string;
  actorId?: string;
  createdFrom?: string;
  createdTo?: string;
  cursor?: string;
}

function toQueryString(filters: AuditLogFilters): string {
  const params = new URLSearchParams();
  if (filters.entity) params.set("entity", filters.entity);
  if (filters.actorId) params.set("actorId", filters.actorId);
  if (filters.createdFrom) params.set("createdFrom", filters.createdFrom);
  if (filters.createdTo) params.set("createdTo", filters.createdTo);
  if (filters.cursor) params.set("cursor", filters.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function listAuditLog(orgId: string, filters: AuditLogFilters = {}): Promise<AuditLogListResponse> {
  const raw = await apiRequest<unknown>(`/audit-log${toQueryString(filters)}`, { orgId });
  return auditLogListResponseSchema.parse(raw);
}
