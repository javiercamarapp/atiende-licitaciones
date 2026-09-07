import { Wifi } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SourceStatusBadge, type FuenteEstado } from "@/components/ui/source-status-badge";
import { describeApiError } from "@/hooks/useAuth";
import { useSourceFreshness } from "@/hooks/useTenders";
import type { SourceRunStatus } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

const ESTADOS_POSIBLES: FuenteEstado[] = ["ok", "caida", "captcha", "cambio_interfaz", "permisos_faltantes"];

// Traduce el vocabulario real de apps/api (`source_run_status`, ver
// packages/db/migrations/0013_source_runs.sql y 0026_widen_source_run_status.sql)
// a las etiquetas de <SourceStatusBadge/>. Un estado no reconocido cae a
// "caida" (nunca a "ok" por defecto — REQ-148: el silencio/lo desconocido
// nunca se interpreta como "cero oportunidades" ni como "todo bien").
function mapSourceRunStatus(status: string): FuenteEstado {
  const known: Record<SourceRunStatus, FuenteEstado> = {
    ok: "ok",
    failed: "fallo",
    captcha: "captcha",
    interface_changed: "cambio_interfaz",
    permission_missing: "permisos_faltantes",
    down: "caida",
    rate_limited: "limitada",
    not_configured: "no_configurada",
    ingest_failed: "fallo_ingesta",
  };
  return (known as Record<string, FuenteEstado>)[status] ?? "caida";
}

/**
 * Estado real de frescura de cada fuente oficial, desde
 * `GET /tenders/sources/freshness` (cualquier usuario autenticado, sin
 * X-Org-Id: la frescura de una fuente pública no es un dato de tenant). No
 * hay datos ficticios: mientras no exista un conector configurado, se
 * muestra el estado vacío en vez de simular una fuente "ok" que no existe.
 * Ver docs/AMPLIACION-BACKOFFICE.md punto 2.
 */
export default function FuentesFrescuraPage() {
  const { data: freshness, isLoading, isError, error, refetch } = useSourceFreshness();

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

      {isLoading && <LoadingState label="Cargando frescura de fuentes…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && (!freshness || freshness.length === 0) && (
        <EmptyState
          icon={Wifi}
          title="Aún no hay fuentes configuradas"
          description="Los conectores de ingesta (por ejemplo, CompraNet) los configura el equipo de operaciones, no esta pantalla. En cuanto haya al menos una fuente activa, aquí aparecerá su estado, última consulta exitosa y cobertura real."
        />
      )}
      {!isLoading && !isError && freshness && freshness.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle level={2}>Fuentes configuradas</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fuente</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Última corrida exitosa (CDMX)</TableHead>
                  <TableHead>Intentos</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {freshness.map((f) => (
                  <TableRow key={f.sourceId}>
                    <TableCell className="font-medium">{f.sourceId}</TableCell>
                    <TableCell>
                      <SourceStatusBadge estado={mapSourceRunStatus(f.status)} />
                    </TableCell>
                    <TableCell>{formatDateTimeMx(f.lastSuccessAt)}</TableCell>
                    <TableCell>{f.attempts}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
