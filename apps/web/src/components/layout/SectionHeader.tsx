import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export interface SectionHeaderProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /**
   * Controles opcionales alineados a la derecha del encabezado (patrón
   * header de Restaurantes: "Chatea con tus datos", campana de
   * notificaciones, fecha en píldora — ver PanelHeaderActions). La mayoría
   * de las páginas de sección no lo usan.
   */
  actions?: ReactNode;
}

/** Encabezado estándar de cada página de sección dentro del panel. */
export function SectionHeader({ icon: Icon, title, description, actions }: SectionHeaderProps) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
        </div>
        <div>
          <h1 className="font-display text-xl font-semibold text-foreground">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
