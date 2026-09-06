import type { LucideIcon } from "lucide-react";

export interface SectionHeaderProps {
  icon: LucideIcon;
  title: string;
  description?: string;
}

/** Encabezado estándar de cada página de sección dentro del panel. */
export function SectionHeader({ icon: Icon, title, description }: SectionHeaderProps) {
  return (
    <div className="mb-6 flex items-start gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
      </div>
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
    </div>
  );
}
