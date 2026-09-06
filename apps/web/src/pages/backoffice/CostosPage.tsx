import { CircleDollarSign } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeApiError } from "@/hooks/useAuth";
import { useAdminCosts } from "@/hooks/useAdmin";

/**
 * Back office / superadmin: costo ESTIMADO de IA por organización
 * (`agent_runs.estimated_cost_usd`) — nunca presentado como facturación
 * real (REQ-169), marcado explícitamente como estimado.
 */
export default function CostosPage() {
  const { data: costs, isLoading, isError, error, refetch } = useAdminCosts();

  return (
    <div>
      <SectionHeader icon={CircleDollarSign} title="Costos" description="Costo estimado de uso de IA por organización (solo superadmin)." />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Estimado, no facturación real</CardTitle>
          <CardDescription>
            Estos montos vienen de `agent_runs.estimated_cost_usd` (una estimación calculada por la plataforma), no de
            un proveedor de facturación real — nunca se presentan como el costo exacto cobrado.
          </CardDescription>
        </CardHeader>
      </Card>
      {isLoading && <LoadingState label="Cargando costos…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && (!costs || costs.length === 0) && (
        <EmptyState icon={CircleDollarSign} title="Sin corridas de agentes todavía" description="En cuanto haya corridas de agentes con costo estimado, aparecerán aquí por organización." />
      )}
      {!isLoading && !isError && costs && costs.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organización</TableHead>
                  <TableHead>Corridas</TableHead>
                  <TableHead>Costo estimado (USD)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {costs.map((c) => (
                  <TableRow key={c.orgId}>
                    <TableCell className="font-medium">{c.orgName}</TableCell>
                    <TableCell>{c.totalRuns}</TableCell>
                    <TableCell>{c.totalEstimatedCostUsd.toLocaleString("en-US", { style: "currency", currency: "USD" })} (estimado)</TableCell>
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
