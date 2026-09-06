import { Wifi } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SourceStatusBadge, type FuenteEstado } from "@/components/ui/source-status-badge";

const ESTADOS_POSIBLES: FuenteEstado[] = ["ok", "caida", "captcha", "cambio_interfaz", "permisos_faltantes"];

/**
 * Estado real de frescura de cada fuente oficial (CompraNet y el portal
 * vigente/sucesor que corresponda). No hay datos ficticios: mientras no
 * exista un conector configurado y verificado contra la fuente oficial, se
 * muestra el estado vacío en vez de simular una fuente "ok" que no existe.
 * Ver docs/AMPLIACION-BACKOFFICE.md punto 2.
 */
export default function FuentesFrescuraPage() {
  return (
    <div>
      <SectionHeader
        icon={Wifi}
        title="Fuentes y frescura"
        description="Estado real de cada fuente oficial de convocatorias y su última consulta exitosa."
      />

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Estados posibles</CardTitle>
          <CardDescription>
            Una fuente caída, con CAPTCHA, con la interfaz cambiada o sin permisos vigentes es un estado explícito —
            nunca se interpreta como "cero convocatorias nuevas".
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {ESTADOS_POSIBLES.map((estado) => (
            <SourceStatusBadge key={estado} estado={estado} />
          ))}
        </CardContent>
      </Card>

      <EmptyState
        icon={Wifi}
        title="Aún no hay fuentes configuradas"
        description="Configura al menos una fuente oficial (por ejemplo, CompraNet) para ver aquí su estado, última consulta exitosa y cobertura real."
      />
    </div>
  );
}
