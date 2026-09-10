// Puerto del shell de modal de atiende-restaurantes
// (src/components/ModalFormularioLateral.tsx, vía el intermedio ya
// adaptado a un stack no-Lovable en atiende-citas-reservaciones) — misma
// identidad visual en toda la plataforma atiende: barra de gradiente, riel
// izquierdo angosto con el logo + título/subtítulo, columna derecha con el
// contenido real (formulario), botones al pie de la columna derecha (no un
// footer de ancho completo). Ninguno de los dos orígenes se modifica (solo
// lectura); este es un hermano en este repo, sobre los primitivos Dialog
// (Radix/shadcn) que YA existen aquí — sin librería de modales nueva.
//
// Solo el shell reutilizable: migrar los modales existentes del repo a este
// componente queda fuera de esta tarea (no se tocó ningún call site).
import { type ReactNode } from "react";
import { X } from "lucide-react";

import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AtiendeMark } from "@/components/AtiendeLogo";
import { cn } from "@/lib/utils";

export interface ModalFormularioLateralProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Título en el riel izquierdo (font-display, bold). */
  titulo: string;
  /** Texto secundario opcional bajo el título, en el riel izquierdo. */
  subtitulo?: string;
  /** Contenido de la columna derecha. */
  children: ReactNode;
  /**
   * Botones al pie de la columna derecha (fila justify-end). Si se omite,
   * se arma un botón primario rounded-full alineado a la derecha con
   * onGuardar/guardando (comportamiento de formulario).
   */
  footer?: ReactNode;
  onGuardar?: () => void;
  guardando?: boolean;
  textoBotonGuardar?: string;
  guardarDeshabilitado?: boolean;
  /** Ancho del modal. @default "max-w-5xl" */
  anchoClase?: string;
  /** Ancho fijo del riel izquierdo. @default "220px" */
  anchoRiel?: string;
  /** Alto mínimo del contenido, para que no "salte" al cambiar de contenido interno. */
  altoMinimoClase?: string;
  /** Oculta el cierre por click-fuera/Escape/X — para flujos que no deben poder abandonarse a medias. */
  bloquearCierre?: boolean;
}

/**
 * Shell reutilizable de modal de dos columnas (riel de marca + formulario).
 * Listo para usarse; no reemplaza ningún modal existente por sí solo.
 */
export function ModalFormularioLateral({
  open,
  onOpenChange,
  titulo,
  subtitulo,
  children,
  footer,
  onGuardar,
  guardando = false,
  textoBotonGuardar = "Guardar cambios",
  guardarDeshabilitado = false,
  anchoClase = "max-w-5xl",
  anchoRiel = "220px",
  altoMinimoClase,
  bloquearCierre = false,
}: ModalFormularioLateralProps) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onOpenChange(false); }}>
      <DialogContent
        hideDefaultClose
        className={cn(anchoClase, "gap-0 overflow-hidden p-0")}
        onInteractOutside={bloquearCierre ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={bloquearCierre ? (e) => e.preventDefault() : undefined}
      >
        <div className="h-1 bg-gradient-to-r from-primary to-secondary" />

        {!bloquearCierre && (
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Cerrar"
            className="absolute right-3 top-4 z-10 flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}

        <div className={cn("grid", altoMinimoClase)} style={{ gridTemplateColumns: `${anchoRiel} 1fr` }}>
          {/* Riel izquierdo: marca (logo) + título/subtítulo. */}
          <div className="flex flex-col gap-6 border-r border-border bg-muted/30 p-6">
            <AtiendeMark className="h-7 w-auto" />
            <div>
              <p className="mb-1 font-display text-base font-semibold text-foreground">{titulo}</p>
              {subtitulo && <p className="text-[13px] leading-snug text-muted-foreground">{subtitulo}</p>}
            </div>
          </div>

          {/* Columna derecha: contenido real + botones al pie. */}
          <div className="flex flex-col p-6">
            <div className="flex-1 overflow-y-auto">{children}</div>
            <div className="mt-auto flex items-center justify-end gap-2 pt-5">
              {footer ?? (
                <Button className="rounded-full px-6" onClick={onGuardar} disabled={guardando || guardarDeshabilitado}>
                  {guardando ? "Guardando…" : textoBotonGuardar}
                </Button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
