import { Users } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { useAuth } from "@/hooks/useAuth";

/**
 * GAP DE API (ronda 3): apps/api no expone ningún endpoint para listar los
 * miembros/roles de una organización (`GET /organizations` solo devuelve
 * las organizaciones del USUARIO ACTUAL con su propio rol —
 * `app.my_organizations`, ver apps/api/src/modules/organizations/routes.ts
 * — no la lista de miembros de una organización). Existen mutaciones
 * (`POST /organizations/invitations`, `PATCH/DELETE
 * /organizations/memberships/:userId`) pero ninguna consulta previa para
 * saber a quién invitar o a quién ya se invitó. Se documenta honestamente
 * en vez de simular una lista de usuarios: hace falta un
 * `GET /organizations/memberships` (o similar) en apps/api antes de poder
 * conectar esta pantalla a datos reales.
 */
export default function UsuariosRolesPage() {
  const { currentOrgId } = useAuth();

  return (
    <div>
      <SectionHeader icon={Users} title="Usuarios y roles" description="Cuentas de acceso y roles asignados dentro de la organización." />
      <EmptyState
        icon={Users}
        title={currentOrgId ? "Endpoint pendiente en apps/api" : "Selecciona una organización"}
        description={
          currentOrgId
            ? "apps/api no expone todavía un endpoint para listar los miembros de una organización (solo invitar/cambiar rol/eliminar). Esta pantalla queda honestamente sin datos hasta que exista GET /organizations/memberships o equivalente."
            : "Elige una organización en el encabezado para ver sus usuarios y roles."
        }
      />
    </div>
  );
}
