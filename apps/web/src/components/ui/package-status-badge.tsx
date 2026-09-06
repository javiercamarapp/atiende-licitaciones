/* eslint-disable react-refresh/only-export-components -- exporta a propósito derivarEstadoPaquete() junto al componente (W-16): es la única vía sancionada para producir "listo" */
import { Badge } from "@/components/ui/badge";

/**
 * Estado real del paquete de entrega. "listo" solo puede resultar de una
 * validación completa (checklist, firmas, anexos y vigencias) que todavía no
 * existe en el backend — por eso ningún llamador de este componente debe
 * pasar "listo" por defecto. Ver docs/AMPLIACION-BACKOFFICE.md punto 8.
 */
export type PaqueteEstado = "borrador" | "listo";

/**
 * W-16: antes, cualquier llamador podía pasar `estado="listo"` a
 * `PackageStatusBadge` sin ninguna guarda — el tipo lo permitía, así que la
 * responsabilidad de no hacerlo recaía enteramente en quien integrara un
 * backend real. `derivarEstadoPaquete()` es la única vía sancionada para
 * producir "listo": exige las tres condiciones explícitas (checklist,
 * firmas, anexos) y, si falta cualquiera, siempre devuelve "borrador" —
 * nunca "listo" por defecto ni por omisión de un campo.
 */
export interface ValidacionPaquete {
  checklistCompleto: boolean;
  firmasCompletas: boolean;
  anexosVigentes: boolean;
}

export function derivarEstadoPaquete(validacion: ValidacionPaquete): PaqueteEstado {
  const { checklistCompleto, firmasCompletas, anexosVigentes } = validacion;
  return checklistCompleto && firmasCompletas && anexosVigentes ? "listo" : "borrador";
}

const ESTADO_CONFIG: Record<PaqueteEstado, { label: string }> = {
  borrador: { label: "Borrador" },
  listo: { label: "Listo para presentar" },
};

export interface PackageStatusBadgeProps {
  estado: PaqueteEstado;
  className?: string;
}

export function PackageStatusBadge({ estado, className }: PackageStatusBadgeProps) {
  const { label } = ESTADO_CONFIG[estado];
  return (
    <Badge variant={estado === "listo" ? "success" : "outline"} className={className}>
      {label}
    </Badge>
  );
}
