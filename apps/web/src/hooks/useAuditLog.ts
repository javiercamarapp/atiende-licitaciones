// Ronda 5: `GET /audit-log` (ronda 4 de apps/api) cierra el hueco
// documentado en README ("Auditoría / Trazabilidad" quedaba honestamente
// vacía por falta de este endpoint). Restringido en la API a
// reviewer/admin/owner de la organización activa -- un rol sin permiso
// recibe 403 real, mostrado tal cual por la página (nunca oculto).
import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import { listAuditLog, type AuditLogFilters } from "@/lib/api/audit";

export function useAuditLog(filters: AuditLogFilters = {}) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["audit-log", currentOrgId, filters],
    queryFn: () => listAuditLog(currentOrgId!, filters),
    enabled: Boolean(currentOrgId),
  });
}
