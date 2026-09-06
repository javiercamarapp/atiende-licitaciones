import { useState } from "react";
import { Link } from "react-router-dom";
import { Radar, ChevronRight } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useTenders } from "@/hooks/useTenders";
import { TENDER_STATUSES, type TenderStatus } from "@/lib/api/schemas";
import { formatDateMx } from "@/lib/datetime";

const STATUS_LABELS: Record<TenderStatus, string> = {
  discovered: "Descubierta",
  in_review: "En revisión",
  go: "Go",
  no_go: "No-Go",
  in_progress: "En preparación",
  submitted: "Presentada",
  won: "Ganada",
  lost: "Perdida",
  cancelled: "Cancelada",
};

export default function DescubrimientoPage() {
  const { currentOrgId } = useAuth();
  const [status, setStatus] = useState<TenderStatus | "todos">("todos");
  const [cursorStack, setCursorStack] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursorStack[cursorStack.length - 1];

  const { data, isLoading, isError, error, refetch, isFetching } = useTenders({
    status: status === "todos" ? undefined : status,
    cursor,
    limit: 20,
  });

  return (
    <div>
      <SectionHeader
        icon={Radar}
        title="Descubrimiento"
        description="Convocatorias reales ingeridas para la organización activa, paginadas por cursor."
      />
      {!currentOrgId ? (
        <EmptyState icon={Radar} title="Selecciona una organización" description="Elige una organización en el encabezado para ver sus convocatorias." />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as TenderStatus | "todos");
                setCursorStack([undefined]);
              }}
            >
              <SelectTrigger aria-label="Filtrar por estado" className="w-[220px]">
                <SelectValue placeholder="Todos los estados" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los estados</SelectItem>
                {TENDER_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {isLoading && <LoadingState label="Cargando convocatorias…" />}
          {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
          {!isLoading && !isError && data && data.items.length === 0 && (
            <EmptyState
              icon={Radar}
              title="Aún no hay convocatorias"
              description="Esta organización no tiene convocatorias ingeridas todavía (o ninguna coincide con el filtro actual). No es un error: es honestamente vacío."
            />
          )}
          {!isLoading && !isError && data && data.items.length > 0 && (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Título</TableHead>
                      <TableHead>Entidad contratante</TableHead>
                      <TableHead>Fuente</TableHead>
                      <TableHead>Plazo (CDMX)</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead className="sr-only">Ver</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.items.map((tender) => (
                      <TableRow key={tender.id}>
                        <TableCell className="font-medium">{tender.title}</TableCell>
                        <TableCell>{tender.contractingBody ?? "—"}</TableCell>
                        <TableCell>{tender.source}</TableCell>
                        <TableCell>{formatDateMx(tender.submissionDeadline)}</TableCell>
                        <TableCell>
                          <Badge variant="secondary">{STATUS_LABELS[tender.status]}</Badge>
                        </TableCell>
                        <TableCell>
                          <Link
                            to={`/convocatorias/descubrimiento/${tender.id}`}
                            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                          >
                            Ver detalle
                            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {data && (data.nextCursor || cursorStack.length > 1) && (
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={cursorStack.length <= 1 || isFetching}
                onClick={() => setCursorStack((stack) => stack.slice(0, -1))}
              >
                Página anterior
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!data.nextCursor || isFetching}
                onClick={() => setCursorStack((stack) => [...stack, data.nextCursor ?? undefined])}
              >
                Página siguiente
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
