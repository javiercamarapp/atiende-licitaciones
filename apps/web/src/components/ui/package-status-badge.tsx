import { Badge } from "@/components/ui/badge";

/**
 * Estado real del paquete de entrega. "listo" solo puede resultar de una
 * validación completa (checklist, firmas, anexos y vigencias) que todavía no
 * existe en el backend — por eso ningún llamador de este componente debe
 * pasar "listo" por defecto. Ver docs/AMPLIACION-BACKOFFICE.md punto 8.
 */
export type PaqueteEstado = "borrador" | "listo";

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
