import { History } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { formatDateTimeMx } from "@/lib/datetime";
import type { AuditLogEntry } from "@/lib/api/schemas";

export interface ActivityFeedProps {
  items: AuditLogEntry[];
  isLoading?: boolean;
  errorMessage?: string | null;
  onRetry?: () => void;
}

/**
 * Actividad reciente desde `GET /audit-log` (ronda 4). Restringida en
 * apps/api a reviewer/admin/owner de la organización activa -- un rol sin
 * permiso recibe 403 real, mostrado tal cual con `<ErrorState/>` (nunca
 * oculto ni disfrazado de "sin actividad").
 */
export function ActivityFeed({ items, isLoading, errorMessage, onRetry }: ActivityFeedProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary" aria-hidden="true" strokeWidth={1.75} />
          <CardTitle level={2} className="text-base">
            Actividad reciente
          </CardTitle>
        </div>
        <CardDescription>Bitácora de auditoría de esta organización.</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <LoadingState label="Cargando actividad reciente…" rows={4} />}
        {!isLoading && errorMessage && <ErrorState message={errorMessage} onRetry={onRetry} />}
        {!isLoading && !errorMessage && items.length === 0 && (
          <EmptyState icon={History} title="Sin actividad todavía" description="Las acciones relevantes de tu organización aparecerán aquí." />
        )}
        {!isLoading && !errorMessage && items.length > 0 && (
          <ul className="space-y-3">
            {items.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-3 border-b border-border pb-3 text-sm last:border-0 last:pb-0">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">
                    {entry.action} · <span className="text-muted-foreground">{entry.entity}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">{formatDateTimeMx(entry.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
