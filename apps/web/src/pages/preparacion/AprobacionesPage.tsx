import { Link, useNavigate } from "react-router-dom";
import { ShieldCheck, ArrowRight } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useTenders } from "@/hooks/useTenders";
import { useApprovalState } from "@/hooks/useExpediente";
import type { Tender } from "@/lib/api/schemas";

const STATE_LABELS: Record<string, { label: string; variant: "outline" | "warning" | "success" }> = {
  borrador: { label: "Borrador", variant: "outline" },
  en_revision: { label: "En revisión", variant: "warning" },
  aprobado: { label: "Aprobado", variant: "success" },
};

/**
 * Bandeja de aprobaciones a través de convocatorias: la API resuelve el
 * estado de aprobación por convocatoria (`GET
 * .../tenders/:tenderId/approval`, ver hooks/useExpediente.ts), no existe
 * un endpoint agregado "todas las aprobaciones pendientes de mi
 * organización" -- esta pantalla lo arma en el cliente sobre la lista de
 * convocatorias real. Distinta de "Revisión" (la acción de aprobar/
 * comentar sobre UNA convocatoria): esta es el tablero de qué convocatoria
 * necesita atención.
 */
function TenderApprovalRow({ tender }: { tender: Tender }) {
  const { data: approval, isLoading, isError } = useApprovalState(tender.id);

  return (
    <TableRow>
      <TableCell className="font-medium">{tender.title}</TableCell>
      <TableCell>
        {isLoading && <span className="text-xs text-muted-foreground">Cargando…</span>}
        {isError && <span className="text-xs text-destructive">Error</span>}
        {!isLoading && !isError && approval && <Badge variant={STATE_LABELS[approval.state]?.variant ?? "outline"}>{STATE_LABELS[approval.state]?.label ?? approval.state}</Badge>}
      </TableCell>
      <TableCell>
        {!isLoading && !isError && approval && (approval.fullyApproved ? "Sí" : "No")}
      </TableCell>
      <TableCell>
        <Link to={`/preparacion/revision?tenderId=${tender.id}`} className="flex items-center gap-1 text-sm font-medium text-primary hover:underline">
          Revisar <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </TableCell>
    </TableRow>
  );
}

export default function AprobacionesPage() {
  const navigate = useNavigate();
  const { currentOrgId } = useAuth();
  const { data: tendersPage, isLoading, isError, error, refetch } = useTenders({ limit: 50 });

  return (
    <div>
      <SectionHeader
        icon={ShieldCheck}
        title="Aprobaciones"
        description="Estado de aprobación del expediente de cada convocatoria — desde aquí se llega a la revisión/aprobación real."
      />

      {!currentOrgId ? (
        <EmptyState icon={ShieldCheck} title="Selecciona una organización" description="Elige una organización en el encabezado para ver sus aprobaciones." />
      ) : (
        <>
          {isLoading && <LoadingState label="Cargando convocatorias…" />}
          {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
          {!isLoading && !isError && (!tendersPage || tendersPage.items.length === 0) && (
            <EmptyState
              icon={ShieldCheck}
              title="Sin convocatorias"
              description="No hay convocatorias todavía para mostrar su estado de aprobación."
              actionLabel="Ir a Descubrimiento"
              onAction={() => navigate("/convocatorias/descubrimiento")}
            />
          )}
          {!isLoading && !isError && tendersPage && tendersPage.items.length > 0 && (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Convocatoria</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Totalmente aprobado</TableHead>
                      <TableHead>Acción</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tendersPage.items.map((tender) => (
                      <TenderApprovalRow key={tender.id} tender={tender} />
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
