import { AlertTriangle, RotateCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface ErrorStateProps {
  /** Mensaje real del error (p. ej. err.message) — nunca un texto genérico
   * que oculte lo que realmente pasó. */
  message: string;
  title?: string;
  onRetry?: () => void;
  className?: string;
}

/**
 * Estado de error honesto: muestra el mensaje real y ofrece una acción de
 * reintentar cuando aplica, en vez de una pantalla genérica "algo salió mal".
 */
export function ErrorState({ message, title = "No se pudo cargar la información", onRetry, className }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-16 text-center",
        className,
      )}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-6 w-6" aria-hidden="true" strokeWidth={1.75} />
      </div>
      <div className="space-y-1">
        <p className="font-display text-base font-semibold text-foreground">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      </div>
      {onRetry && (
        <Button type="button" size="sm" variant="outline" onClick={onRetry} className="mt-2 gap-1.5">
          <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
          Reintentar
        </Button>
      )}
    </div>
  );
}
