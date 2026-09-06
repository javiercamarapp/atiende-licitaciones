import { Sparkles } from "lucide-react";

/**
 * REQ-115: disclosure de uso de IA obligatorio también en el "portal" (no
 * solo WhatsApp/voz/PDF/escritos dirigidos a la autoridad). Componente
 * reutilizable pensado para anteponerse a cualquier contenido generado por
 * IA (Redacción, Revisión, Análisis de bases…) — hoy esos módulos todavía
 * no generan contenido real (son `EmptyState`), pero el aviso ya está listo
 * para cuando exista un backend que sí lo haga, en vez de añadirse después
 * de que el contenido generado ya esté en pantalla.
 */
export function AiDisclosureNote() {
  return (
    <div
      role="note"
      aria-label="Aviso de uso de inteligencia artificial"
      className="mb-6 flex items-start gap-3 rounded-2xl border border-border bg-muted/50 px-4 py-3 text-sm text-muted-foreground"
    >
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" strokeWidth={1.75} />
      <p>
        El contenido de este módulo puede generarse con apoyo de inteligencia artificial. Revísalo antes de usarlo:
        tú decides qué se presenta ante la autoridad.
      </p>
    </div>
  );
}
