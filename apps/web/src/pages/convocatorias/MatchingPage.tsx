import { useNavigate } from "react-router-dom";
import { Target, AlertTriangle } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useTenderMatches } from "@/hooks/useMatching";
import { useTenders } from "@/hooks/useTenders";
import type { EligibilityStatus } from "@/lib/api/schemas";

const ELIGIBILITY_CONFIG: Record<EligibilityStatus, { label: string; variant: "success" | "destructive" | "outline" }> = {
  cumple: { label: "Elegible", variant: "success" },
  no_cumple: { label: "No elegible", variant: "destructive" },
  no_evaluable: { label: "No evaluable (faltan datos)", variant: "outline" },
};

const MISSING_FIELD_LABELS: Record<string, string> = {
  capabilities_or_products: "Capacidades o productos/servicios del perfil de empresa",
  locations: "Ubicaciones del perfil de empresa",
};

export default function MatchingPage() {
  const navigate = useNavigate();
  const { currentOrgId } = useAuth();
  const { data: matches, isLoading, isError, error, refetch } = useTenderMatches();
  const { data: tendersPage } = useTenders({ limit: 50 });

  const titleById = new Map((tendersPage?.items ?? []).map((t) => [t.id, t.title] as const));

  return (
    <div>
      <SectionHeader
        icon={Target}
        title="Matching"
        description="Relevancia y elegibilidad calculadas por separado, con el desglose real de cada criterio — nunca un solo score que mezcle ambas cosas."
      />
      {!currentOrgId ? (
        <EmptyState icon={Target} title="Selecciona una organización" description="Elige una organización en el encabezado para calcular su matching." />
      ) : (
        <>
          {isLoading && <LoadingState label="Calculando matching…" />}
          {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
          {!isLoading && !isError && (!matches || matches.length === 0) && (
            <EmptyState
              icon={Target}
              title="Sin convocatorias para calcular matching"
              description="Esta organización no tiene convocatorias ingeridas todavía."
              actionLabel="Ir a Descubrimiento"
              onAction={() => navigate("/convocatorias/descubrimiento")}
            />
          )}
          <div className="space-y-4">
            {matches?.map((match) => {
              const eligibility = ELIGIBILITY_CONFIG[match.eligibility.status];
              return (
                <Card key={match.tenderId}>
                  <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
                    <div>
                      <CardTitle level={2} className="text-base">
                        {titleById.get(match.tenderId) ?? match.tenderKey}
                      </CardTitle>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="secondary">Relevancia {match.relevance.score}/100</Badge>
                      <Badge variant={eligibility.variant}>{eligibility.label}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Criterios de relevancia</p>
                      <ul className="space-y-1.5 text-sm">
                        {match.relevance.criteria.map((c, i) => (
                          <li key={i} className="flex items-baseline justify-between gap-2">
                            <span>{c.criterion}</span>
                            <span className="whitespace-nowrap text-xs text-muted-foreground">
                              {c.score}/{c.maxScore}
                            </span>
                          </li>
                        ))}
                        {match.relevance.criteria.length === 0 && <li className="text-muted-foreground">Sin criterios evaluados.</li>}
                      </ul>
                    </div>
                    <div>
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Criterios de elegibilidad</p>
                      <ul className="space-y-1.5 text-sm">
                        {match.eligibility.criteria.map((c, i) => (
                          <li key={i}>
                            <span className="font-medium">{c.requirement}</span>: {c.explanation}
                          </li>
                        ))}
                        {match.eligibility.criteria.length === 0 && <li className="text-muted-foreground">Sin criterios evaluados.</li>}
                      </ul>
                    </div>
                    {match.missingProfileFields.length > 0 && (
                      <div className="sm:col-span-2 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" aria-hidden="true" />
                        <p>
                          <span className="font-medium">Faltan datos para evaluar por completo: </span>
                          {match.missingProfileFields.map((f) => MISSING_FIELD_LABELS[f] ?? f).join(", ")}.
                        </p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
