import { Wifi } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeApiError } from "@/hooks/useAuth";
import { useAdminConnectorFreshness } from "@/hooks/useAdmin";
import { formatDateTimeMx } from "@/lib/datetime";

/**
 * Back office / superadmin: detalle crudo de `source_runs` (no la vista
 * agregada por tenant), con `isStale` explícito (umbral de 6h sin corrida
 * exitosa, REQ-149 — nunca "cero oportunidades" silencioso). Un usuario
 * normal recibe 403 real de la API.
 */
export default function ConectoresPage() {
  const { data: connectors, isLoading, isError, error, refetch } = useAdminConnectorFreshness();

  return (
    <div>
      <SectionHeader icon={Wifi} title="Conectores" description="Detalle crudo de frescura por fuente, con obsolescencia explícita (solo superadmin)." />
      {isLoading && <LoadingState label="Cargando conectores…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && (!connectors || connectors.length === 0) && (
        <EmptyState icon={Wifi} title="Aún no hay conectores con corridas registradas" description="Las corridas de ingesta de cada fuente aparecerán aquí." />
      )}
      {!isLoading && !isError && connectors && connectors.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fuente</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Última corrida exitosa (CDMX)</TableHead>
                  <TableHead>Intentos</TableHead>
                  <TableHead>Obsoleta</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {connectors.map((c) => (
                  <TableRow key={c.sourceId}>
                    <TableCell className="font-medium">{c.sourceId}</TableCell>
                    <TableCell>{c.status}</TableCell>
                    <TableCell>{formatDateTimeMx(c.lastSuccessAt)}</TableCell>
                    <TableCell>{c.attempts}</TableCell>
                    <TableCell>
                      <Badge variant={c.isStale ? "destructive" : "success"}>{c.isStale ? "Sí" : "No"}</Badge>
                    </TableCell>
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
