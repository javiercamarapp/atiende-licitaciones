import { Badge, type BadgeProps } from "@/components/ui/badge";

/**
 * Estados reales de una fuente de convocatorias (p. ej. CompraNet o el
 * portal oficial vigente/sucesor). Un silencio de la fuente NUNCA se
 * interpreta como "cero oportunidades": cada estado se etiqueta de forma
 * explícita, siguiendo la disciplina de diseño heredada de
 * atiende-restaurantes de que "cada estado lleva etiqueta, no solo color"
 * (ver docs/investigacion/frontend-restaurantes.md §2.1) — aplicada aquí a
 * los requisitos de docs/AMPLIACION-BACKOFFICE.md punto 2.
 */
export type FuenteEstado =
  | "ok"
  | "caida"
  | "captcha"
  | "cambio_interfaz"
  | "permisos_faltantes"
  // Ronda 3: apps/api expone `source_run_status` real (packages/db,
  // 0013/0026), con más matices que los 5 estados originales de esta
  // ronda 1 — se agregan sin quitar los existentes (ver
  // pages/convocatorias/FuentesFrescuraPage.tsx, `mapSourceRunStatus`).
  | "fallo"
  | "limitada"
  | "no_configurada"
  | "fallo_ingesta";

const ESTADO_CONFIG: Record<FuenteEstado, { label: string; variant: BadgeProps["variant"] }> = {
  ok: { label: "OK", variant: "success" },
  caida: { label: "Caída", variant: "destructive" },
  captcha: { label: "CAPTCHA", variant: "warning" },
  cambio_interfaz: { label: "Cambio de interfaz", variant: "warning" },
  permisos_faltantes: { label: "Permisos faltantes", variant: "destructive" },
  fallo: { label: "Falló", variant: "destructive" },
  limitada: { label: "Limitada por tasa", variant: "warning" },
  no_configurada: { label: "Sin configurar", variant: "outline" },
  fallo_ingesta: { label: "Falló la ingesta", variant: "warning" },
};

export interface SourceStatusBadgeProps {
  estado: FuenteEstado;
  className?: string;
}

export function SourceStatusBadge({ estado, className }: SourceStatusBadgeProps) {
  const { label, variant } = ESTADO_CONFIG[estado];
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
}
