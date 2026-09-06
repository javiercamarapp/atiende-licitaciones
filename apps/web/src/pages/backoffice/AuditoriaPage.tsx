import { History } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * GAP DE API (ronda 3): apps/api mantiene `audit_log` con una cadena de
 * hashes verificable (`app.verify_audit_log_chain()`, ver
 * packages/db/README.md) y escribe en él en cada mutación relevante, pero
 * no expone NINGÚN endpoint HTTP para leerlo (ni por organización ni en back
 * office). Se documenta honestamente en vez de inventar un historial: hace
 * falta un `GET /audit-log` (con filtro por organización, tal vez
 * `GET /admin/audit-log` para el back office) en apps/api antes de conectar
 * esta pantalla.
 */
export default function AuditoriaPage() {
  return (
    <div>
      <SectionHeader icon={History} title="Auditoría / Trazabilidad" description="Historial de acciones relevantes realizadas en la plataforma." />
      <EmptyState
        icon={History}
        title="Endpoint pendiente en apps/api"
        description="apps/api registra audit_log en cada mutación sensible (packages/db), pero no expone todavía ningún endpoint HTTP para leerlo. Esta pantalla queda honestamente sin datos hasta que exista GET /audit-log o equivalente."
      />
    </div>
  );
}
