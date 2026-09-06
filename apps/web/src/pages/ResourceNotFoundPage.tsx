import { Link } from "react-router-dom";
import { FileQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Guard 404 de tenant cruzado (docs/TABLERO.md §6, REQ-049/065): cuando el
 * ID de un recurso en la URL (p. ej. `/convocatorias/descubrimiento/:tenderId`)
 * pertenece a OTRA organización, `apps/api` responde 403/404 real vía RLS
 * (el aislamiento real ya es correcto — 0 fugas de datos confirmadas, ver
 * `docs/auditoria-1/*`). Lo que faltaba en `apps/web` era una página 404
 * DEDICADA para ese caso: antes se mostraba el mensaje crudo del 403
 * ("no tienes permiso...") con `<ErrorState/>`, lo cual CONFIRMA
 * implícitamente que el recurso existe (solo que no es tuyo) — una fuga de
 * información menor pero real. Esta pantalla es indistinguible de un
 * recurso que simplemente no existe: mismo mensaje, mismo diseño, ningún
 * detalle sobre el motivo real (403 vs. 404 vs. borrado).
 */
export default function ResourceNotFoundPage() {
  return (
    <div role="alert" className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-card/50 px-6 py-24 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <FileQuestion className="h-7 w-7" aria-hidden="true" strokeWidth={1.75} />
      </div>
      <div>
        <h1 className="font-display text-xl font-semibold text-foreground">Recurso no encontrado</h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          No existe, fue movido, o no pertenece a tu organización actual. Verifica el enlace o cambia de organización
          en el encabezado.
        </p>
      </div>
      <Button asChild>
        <Link to="/panel">Volver al panel</Link>
      </Button>
    </div>
  );
}
