import { useState } from "react";
import { History, Route } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useAuditLog } from "@/hooks/useAuditLog";
import { formatDateTimeMx } from "@/lib/datetime";

/**
 * `GET /audit-log` (ronda 4) — bitácora de la organización activa,
 * restringida a reviewer/admin/owner en apps/api (más estricto que su RLS
 * real). Un rol sin permiso recibe 403 real de la API, mostrado tal cual
 * con `<ErrorState/>` — nunca se oculta el enlace como única barrera.
 *
 * Ronda 5 (REQ-171): filtro por `correlationId` reconstruye la traza
 * completa de un flujo de negocio (p. ej. perfil → tarifa → propuesta →
 * checklist → aprobación → paquete), no solo eventos aislados por
 * entidad/actor.
 */
export default function AuditoriaPage() {
  const { currentOrgId } = useAuth();
  const [entity, setEntity] = useState("");
  const [correlationId, setCorrelationId] = useState("");
  const { data, isLoading, isError, error, refetch } = useAuditLog({ entity: entity || undefined, correlationId: correlationId || undefined });

  return (
    <div>
      <SectionHeader icon={History} title="Auditoría / Trazabilidad" description="Bitácora append-only (hash encadenado) de acciones relevantes de esta organización." />

      {!currentOrgId ? (
        <EmptyState icon={History} title="Selecciona una organización" description="Elige una organización en el encabezado para ver su bitácora." />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <Input
              aria-label="Filtrar por entidad"
              placeholder="Filtrar por entidad (p. ej. tender_documents, proposals)…"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              className="max-w-md"
            />
            <Input
              aria-label="Filtrar por id de correlación"
              placeholder="Filtrar por id de correlación (traza de un flujo completo)…"
              value={correlationId}
              onChange={(e) => setCorrelationId(e.target.value)}
              className="max-w-md"
            />
            {correlationId && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setCorrelationId("")}>
                Quitar filtro de traza
              </Button>
            )}
          </div>

          {isLoading && <LoadingState label="Cargando bitácora…" />}
          {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
          {!isLoading && !isError && (!data || data.items.length === 0) && (
            <EmptyState icon={History} title="Sin eventos" description="No hay eventos de auditoría que coincidan con el filtro actual." />
          )}
          {!isLoading && !isError && data && data.items.length > 0 && (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Fecha (CDMX)</TableHead>
                      <TableHead>Acción</TableHead>
                      <TableHead>Entidad</TableHead>
                      <TableHead>ID de entidad</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>request_id</TableHead>
                      <TableHead>Traza</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((entry) => (
                      <TableRow key={entry.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTimeMx(entry.createdAt)}</TableCell>
                        <TableCell className="font-medium">{entry.action}</TableCell>
                        <TableCell>{entry.entity}</TableCell>
                        <TableCell className="max-w-[180px] truncate text-xs text-muted-foreground">{entry.entityId ?? "—"}</TableCell>
                        <TableCell className="max-w-[180px] truncate text-xs text-muted-foreground">{entry.actorId ?? "sistema"}</TableCell>
                        <TableCell className="max-w-[140px] truncate text-xs text-muted-foreground">{entry.requestId ?? "—"}</TableCell>
                        <TableCell>
                          {entry.correlationId ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="gap-1 text-xs"
                              aria-label={`Ver traza completa de ${entry.correlationId}`}
                              onClick={() => setCorrelationId(entry.correlationId!)}
                            >
                              <Route className="h-3.5 w-3.5" aria-hidden="true" />
                              Ver traza
                            </Button>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
