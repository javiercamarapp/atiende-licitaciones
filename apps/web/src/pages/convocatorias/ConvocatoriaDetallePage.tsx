import { useParams, Link } from "react-router-dom";
import { ArrowLeft, FileSearch } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { describeApiError } from "@/hooks/useAuth";
import { useTender, useTenderVersions, useTenderChangeEvents } from "@/hooks/useTenders";
import type { ChangeKind } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  publication: "Publicación",
  amendment: "Enmienda",
  annex: "Anexo",
  deadline_change: "Cambio de plazo",
  clarification: "Aclaración",
  cancellation: "Cancelación",
};

function VersionesTab({ tenderId }: { tenderId: string }) {
  const { data: versions, isLoading, isError, error, refetch } = useTenderVersions(tenderId);

  if (isLoading) return <LoadingState label="Cargando versiones…" />;
  if (isError) return <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />;
  if (!versions || versions.length === 0) {
    return <EmptyState icon={FileSearch} title="Sin versiones registradas" description="Esta convocatoria no tiene historial de versiones todavía." />;
  }
  return (
    <ul className="space-y-3">
      {versions.map((v) => (
        <li key={v.id}>
          <Card>
            <CardContent className="flex items-start justify-between gap-4 p-4">
              <div>
                <p className="font-medium text-foreground">{CHANGE_KIND_LABELS[v.changeKind]}</p>
                <p className="text-xs text-muted-foreground">Versión de origen: {v.sourceVersion}</p>
              </div>
              <p className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTimeMx(v.effectiveAt)}</p>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function EventosTab({ tenderId }: { tenderId: string }) {
  const { data: events, isLoading, isError, error, refetch } = useTenderChangeEvents(tenderId);

  if (isLoading) return <LoadingState label="Cargando eventos…" />;
  if (isError) return <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />;
  if (!events || events.length === 0) {
    return (
      <EmptyState
        icon={FileSearch}
        title="Sin eventos ni aclaraciones registradas"
        description="Publicaciones, enmiendas, cambios de plazo y aclaraciones aparecerán aquí en cuanto la fuente los reporte."
      />
    );
  }
  return (
    <ul className="space-y-3">
      {events.map((e) => (
        <li key={e.id}>
          <Card>
            <CardContent className="flex items-start justify-between gap-4 p-4">
              <div>
                <Badge variant={e.changeKind === "clarification" || e.changeKind === "deadline_change" ? "warning" : "secondary"}>
                  {CHANGE_KIND_LABELS[e.changeKind]}
                </Badge>
                <p className="mt-1.5 text-sm text-foreground">{e.summary ?? "Sin resumen."}</p>
              </div>
              <p className="whitespace-nowrap text-xs text-muted-foreground">{formatDateTimeMx(e.createdAt)}</p>
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

export default function ConvocatoriaDetallePage() {
  const { tenderId } = useParams<{ tenderId: string }>();
  const { data: tender, isLoading, isError, error, refetch } = useTender(tenderId ?? null);

  return (
    <div>
      <Link to="/convocatorias/descubrimiento" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Volver a Descubrimiento
      </Link>

      {isLoading && <LoadingState label="Cargando convocatoria…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && tender && (
        <>
          <SectionHeader icon={FileSearch} title={tender.title} description={tender.contractingBody ?? "Entidad contratante no especificada"} />

          <Card className="mb-6">
            <CardHeader>
              <CardTitle level={2}>Datos generales</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <p><span className="text-muted-foreground">Fuente: </span>{tender.source}</p>
              <p><span className="text-muted-foreground">ID externo: </span>{tender.externalId}</p>
              <p><span className="text-muted-foreground">Presupuesto: </span>{tender.budgetAmount != null ? tender.budgetAmount.toLocaleString("es-MX", { style: "currency", currency: tender.currency }) : "No especificado"}</p>
              <p><span className="text-muted-foreground">Plazo de presentación (CDMX): </span>{formatDateTimeMx(tender.submissionDeadline)}</p>
              <p><span className="text-muted-foreground">Publicada (CDMX): </span>{formatDateTimeMx(tender.publishedAt)}</p>
              {tender.url && (
                <p>
                  <a href={tender.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    Ver convocatoria en la fuente original
                  </a>
                </p>
              )}
            </CardContent>
          </Card>

          <Tabs defaultValue="versiones">
            <TabsList>
              <TabsTrigger value="versiones">Versiones</TabsTrigger>
              <TabsTrigger value="eventos">Eventos / aclaraciones</TabsTrigger>
            </TabsList>
            <TabsContent value="versiones">
              <VersionesTab tenderId={tender.id} />
            </TabsContent>
            <TabsContent value="eventos">
              <EventosTab tenderId={tender.id} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
