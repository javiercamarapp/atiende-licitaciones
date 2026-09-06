import type { z } from "zod";
import type { NotificationCategory } from "../preferences/types";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * El contrato de una plantilla del catálogo: id estable (se usa como
 * `messageKey`/nombre de log), categoría (para el filtro de preferencias),
 * si es obligatoria (no se puede apagar), su esquema zod de variables —
 * fuente única para validar en tiempo de ejecución lo que le llega desde
 * `apps/api`/`apps/worker` — y `render()`, que nunca lanza por datos de
 * negocio inválidos: eso lo atrapa `schema.parse()` antes de llamarlo.
 */
export interface TemplateDefinition<V> {
  id: string;
  name: string;
  category: NotificationCategory;
  mandatory: boolean;
  schema: z.ZodType<V>;
  /** Datos de ejemplo, EXPLÍCITAMENTE marcados como tales en el propio
   *  contenido (ver cada plantilla) — los usa `scripts/preview.ts`. */
  sampleData: V;
  render(vars: V): Promise<RenderedEmail>;
}

/** Type-erased para el registro (`registry.ts`), que mezcla plantillas con
 *  distintos tipos de variables en un solo mapa. */
export type AnyTemplateDefinition = TemplateDefinition<unknown>;
