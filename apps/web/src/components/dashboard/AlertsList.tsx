import { AlertTriangle, Timer } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { formatDateMx } from "@/lib/datetime";
import type { Followup } from "@/lib/api/schemas";

export interface AlertsListProps {
  items: Followup[];
  isLoading?: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
}

/**
 * Alertas post-adjudicación (REQ-056, `GET /expediente/post-award-alerts`):
 * vencimientos próximos/vencidos a través de TODAS las convocatorias de la
 * organización activa.
 */
export function AlertsList({ items, isLoading, errorMessage, onRetry }: AlertsListProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Timer className="h-5 w-5 text-primary" aria-hidden="true" strokeWidth={1.75} />
          <CardTitle level={2} className="text-base">
            Vencimientos y seguimiento post-adjudicación
          </CardTitle>
        </div>
        <CardDescription>Hitos, garantías, facturación y pagos con alerta activa.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <LoadingState label="Cargando alertas…" rows={3} />}
        {!isLoading && errorMessage && <ErrorState message={errorMessage} onRetry={onRetry} />}
        {!isLoading && !errorMessage && items.length === 0 && (
          <EmptyState icon={Timer} title="Sin alertas activas" description="No hay vencimientos próximos ni vencidos en este momento." />
        )}
        {!isLoading && !errorMessage && items.length > 0 && (
          <ul className="space-y-3">
            {items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 border-b border-border pb-3 text-sm last:border-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{item.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.kind} · vence {formatDateMx(item.dueDate)}
                  </p>
                </div>
                <Badge variant={item.alertLevel === "vencido" ? "destructive" : "warning"} className="shrink-0 gap-1">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  {item.alertLevel === "vencido" ? "Vencido" : "Próximo"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
