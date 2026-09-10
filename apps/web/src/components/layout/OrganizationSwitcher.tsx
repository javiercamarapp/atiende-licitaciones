import { Building2 } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { ROLE_LABELS } from "@/lib/roles";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Selector de organización del header, con datos reales de
 * `GET /organizations` (memberships del usuario autenticado, cada una con
 * su rol real). Cambiar de organización actualiza el header `X-Org-Id` que
 * usa el resto de la app (ver hooks/useAuth.tsx) — el servidor sigue
 * revalidando la membresía en cada petición (`app.requireOrg`), este
 * selector solo decide CUÁL header enviar.
 */
export function OrganizationSwitcher() {
  const { memberships, currentOrgId, currentMembership, switchOrg } = useAuth();

  const sinOrganizaciones = memberships.length === 0;

  return (
    <Select value={currentOrgId ?? undefined} onValueChange={switchOrg} disabled={sinOrganizaciones}>
      {/*
       * W-21/W-22 (docs/auditoria-1/web-reverificacion-2.md): esta pieza
       * usaba `w-[180px]`/`w-[200px]` FIJO, que nunca se encoge — dentro del
       * header sin `flex-wrap` eso empujaba a `ThemeSelector` fuera del
       * viewport (invisible/intocable) en todo ancho <466px, y el propio
       * disparador medía 36px de alto (por debajo del objetivo de ≥44px que
       * ya cumplen enlaces/botones de acordeón, W-10/W-19). Ahora: `h-11`
       * (44px reales, no solo padding) + ancho fluido (`min-w-0 flex-1` en
       * móvil, con techo `max-w-[9.5rem]`; ancho fijo mayor desde `sm`) con
       * `truncate` en el contenido (abajo) para que un nombre de
       * organización largo jamás vuelva a forzar overflow del header.
       */}
      <SelectTrigger
        aria-label="Organización"
        className="h-11 min-w-0 max-w-[9.5rem] flex-1 gap-1.5 text-sm sm:max-w-none sm:w-[240px] sm:flex-none"
      >
        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" strokeWidth={1.75} />
        <SelectValue placeholder={sinOrganizaciones ? "Sin organizaciones" : "Selecciona organización"}>
          {currentMembership && (
            <span className="truncate">
              {currentMembership.name}
              <span className="ml-1.5 text-xs text-muted-foreground">({ROLE_LABELS[currentMembership.role] ?? currentMembership.role})</span>
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {memberships.map((org) => (
          <SelectItem key={org.id} value={org.id}>
            {org.name} <span className="text-xs text-muted-foreground">({ROLE_LABELS[org.role] ?? org.role})</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
