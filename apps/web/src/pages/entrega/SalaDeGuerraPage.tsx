import { useState } from "react";
import { AlertTriangle, ShieldCheck, Timer, FileArchive, ListChecks, PlayCircle } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { TenderSelect } from "@/components/expediente/TenderSelect";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useWarRoomChecklist, useRunWarRoomChecklist } from "@/hooks/useExpediente";
import { WRITE_ROLES, type WarRoomDimension, type WarRoomItem } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

const DIMENSION_LABEL: Record<WarRoomDimension, { label: string; icon: typeof ShieldCheck }> = {
  checklist_anti_desechamiento: { label: "Anti-desechamiento", icon: ShieldCheck },
  cuenta_regresiva: { label: "Cuenta regresiva", icon: Timer },
  hash_zip: { label: "Hash del ZIP", icon: FileArchive },
  holgura_24h: { label: "Holgura obligatoria de 24h", icon: ListChecks },
};

function badgeVariant(status: WarRoomItem["status"]): "success" | "warning" | "destructive" {
  return status === "verde" ? "success" : status === "ambar" ? "warning" : "destructive";
}

function formatHours(hours: number | null): string {
  if (hours === null) return "sin fecha límite conocida";
  if (hours < 0) return `venció hace ${Math.abs(hours).toFixed(1)} h`;
  return `${hours.toFixed(1)} h restantes`;
}

/**
 * REQ-040: gate operativo de "sala de guerra" -- se corre a mano antes de
 * cada acto de apertura. Quién lo ve: cualquier miembro de la organización
 * con acceso a esta convocatoria (incluido `viewer`, de solo lectura).
 * Quién lo dispara: un rol de escritura (`WRITE_ROLES`), igual que el resto
 * de acciones del expediente que cambian estado. Cuándo se dispara: manual,
 * las veces que haga falta -- cada corrida queda en un historial inmutable
 * (nunca se sobrescribe una corrida pasada), así que "cuándo" lo decide el
 * equipo, idealmente con horas de margen antes del acto (por eso existe la
 * dimensión de holgura obligatoria).
 */
export default function SalaDeGuerraPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const [tenderId, setTenderId] = useState<string | null>(null);
  const canWrite = Boolean(currentMembership && WRITE_ROLES.includes(currentMembership.role));
  const { data: report, isLoading, isError, error, refetch } = useWarRoomChecklist(tenderId);
  const run = useRunWarRoomChecklist(tenderId);

  const onRun = async () => {
    try {
      const result = await run.mutateAsync();
      toast[result.overallStatus === "verde" ? "success" : "error"](
        result.overallStatus === "verde"
          ? "Sala de guerra: las 4 dimensiones están en verde."
          : `Sala de guerra: hay pendientes (${result.items.filter((i) => i.status !== "verde").map((i) => DIMENSION_LABEL[i.dimension].label).join(", ")}).`,
      );
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <div>
      <SectionHeader
        icon={AlertTriangle}
        title="Sala de guerra"
        description="Checklist operativo del día de apertura: anti-desechamiento, cuenta regresiva, hash del ZIP y holgura obligatoria de 24h antes de la fecha límite."
      />

      {!currentOrgId ? (
        <EmptyState icon={AlertTriangle} title="Selecciona una organización" description="Elige una organización en el encabezado para correr su checklist de sala de guerra." />
      ) : (
        <div className="space-y-6">
          <TenderSelect value={tenderId} onChange={setTenderId} />

          {tenderId && (
            <>
              {canWrite && (
                <Button type="button" variant="outline" className="gap-1.5" disabled={run.isPending} onClick={onRun}>
                  <PlayCircle className="h-4 w-4" aria-hidden="true" />
                  {run.isPending ? "Corriendo checklist…" : "Correr checklist de sala de guerra"}
                </Button>
              )}
              {!canWrite && (
                <p className="text-sm text-muted-foreground">Tu rol puede ver el historial, pero solo un rol de escritura puede correr el checklist.</p>
              )}

              {isLoading && <LoadingState label="Cargando última corrida…" />}
              {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
              {!isLoading && !isError && !report && (
                <EmptyState
                  icon={AlertTriangle}
                  title="Todavía no se ha corrido el checklist"
                  description="Córrelo antes del acto de apertura. Cada corrida queda registrada; puedes volver a correrlo tantas veces como haga falta tras corregir un pendiente."
                />
              )}
              {!isLoading && !isError && report && (
                <Card>
                  <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div>
                      <CardTitle level={2} className="text-base">
                        Última corrida
                      </CardTitle>
                      <CardDescription>
                        {formatDateTimeMx(report.computedAt)} · {formatHours(report.hoursUntilDeadline)}
                      </CardDescription>
                    </div>
                    <Badge variant={badgeVariant(report.overallStatus)}>{report.overallStatus}</Badge>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {report.items.map((item) => {
                      const meta = DIMENSION_LABEL[item.dimension];
                      const Icon = meta.icon;
                      return (
                        <div key={item.dimension} className="flex items-start gap-3 rounded-md border border-border p-3">
                          <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-medium text-foreground">{meta.label}</p>
                              <Badge variant={badgeVariant(item.status)}>{item.status}</Badge>
                            </div>
                            <p className="mt-1 text-sm text-muted-foreground">{item.detail}</p>
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
