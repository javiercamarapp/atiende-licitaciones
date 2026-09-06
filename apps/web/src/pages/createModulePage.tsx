import type { LucideIcon } from "lucide-react";

import { AiDisclosureNote } from "@/components/AiDisclosureNote";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";

export interface ModulePageConfig {
  icon: LucideIcon;
  title: string;
  description: string;
  emptyTitle: string;
  emptyDescription: string;
  /**
   * REQ-115: este módulo mostrará contenido generado por IA (redacción,
   * revisión, análisis) en cuanto exista backend — el aviso se añade desde
   * ahora, antes de que haya contenido real que mostrar, en vez de después.
   */
  disclosure?: boolean;
}

/**
 * Fábrica de páginas de módulo: cada módulo del sidebar (§10.1 del informe)
 * aún no tiene datos reales detrás, así que todas comparten el mismo
 * esqueleto honesto — encabezado de sección + EmptyState con el mensaje
 * específico del módulo — en vez de datos "de demo" hardcodeados.
 */
export function createModulePage({ icon, title, description, emptyTitle, emptyDescription, disclosure }: ModulePageConfig) {
  function ModulePage() {
    return (
      <div>
        <SectionHeader icon={icon} title={title} description={description} />
        {disclosure && <AiDisclosureNote />}
        <EmptyState icon={icon} title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }
  ModulePage.displayName = `ModulePage(${title})`;
  return ModulePage;
}
