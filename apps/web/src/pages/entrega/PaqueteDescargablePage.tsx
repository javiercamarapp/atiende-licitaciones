import { PackageCheck, ShieldAlert } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { derivarEstadoPaquete, PackageStatusBadge } from "@/components/ui/package-status-badge";

// El paquete solo puede pasar a "listo" cuando exista una validación real
// (checklist completo, firmas, anexos y vigencias vigentes) — esa lógica de
// backend no existe todavía en esta ronda. Se deriva con
// `derivarEstadoPaquete()` (W-16) en vez de un literal "borrador" suelto,
// para que el único cambio posible a "listo" pase por las tres condiciones
// explícitas y no por editar un valor hardcodeado.
const ESTADO_ACTUAL = derivarEstadoPaquete({
  checklistCompleto: false,
  firmasCompletas: false,
  anexosVigentes: false,
});

export default function PaqueteDescargablePage() {
  return (
    <div>
      <SectionHeader
        icon={PackageCheck}
        title="Paquete descargable"
        description="Documentos exigidos, índice/manifiesto, checklist y versiones listos para descargar."
      />

      <Card className="mb-6 border-warning/40 bg-warning/5">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" strokeWidth={1.75} />
          <div>
            <CardTitle className="text-base">La presentación y firma las realiza el usuario</CardTitle>
            <CardDescription>
              Esta plataforma no presenta ofertas ni firma documentos en tu nombre, ni actúa en portales oficiales o
              contacta terceros por su cuenta. Tú revisas y presentas el expediente.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>

      <div className="mb-6 flex items-center gap-3">
        <span className="text-sm font-medium text-muted-foreground">Estado del paquete:</span>
        <PackageStatusBadge estado={ESTADO_ACTUAL} />
      </div>

      <EmptyState
        icon={PackageCheck}
        title="Aún no hay paquete generado"
        description="El paquete se genera cuando el expediente de una convocatoria está completo. Mientras falten datos, firmas o anexos, se exporta como borrador — nunca como listo."
      />
    </div>
  );
}
