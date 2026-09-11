import { useState } from "react";
import { Bot, Check, X } from "lucide-react";

import { StepUpDialog } from "@/components/StepUpDialog";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useAgentRuns, useToolCalls, useApproveToolCall, useDenyToolCall } from "@/hooks/useAgents";
import { MEMBERSHIP_ADMIN_ROLES, type ToolCall } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

const AUTH_STATUS_CONFIG: Record<ToolCall["authorizationStatus"], { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
  auto: { label: "Automática", variant: "secondary" },
  pending: { label: "Pendiente de aprobación", variant: "warning" },
  approved: { label: "Aprobada", variant: "success" },
  denied: { label: "Denegada", variant: "destructive" },
};

/**
 * Persistencia real de packages/agents (`agent_runs`/`tool_calls`, ver
 * apps/api/README.md módulo `agents`) para la organización activa. La
 * orquestación de agentes en sí (proveedores LLM reales) queda fuera de esta
 * ronda — esta pantalla es honesta sobre eso: si no hay corridas, dice
 * exactamente eso, no inventa actividad.
 *
 * REQ-193 (docs/REQUISITOS.md): el EmptyState de "Corridas de agentes" decía
 * "Aún no hay agentes configurados", lo que prometía una acción de
 * configuración que no existe en ninguna pantalla (no hay endpoint ni botón
 * para iniciar una corrida manualmente -- se disparan solo desde el backend,
 * ver apps/api/src/lib/agent-triggers.ts). Se corrigió la copia para no
 * prometer esa acción en vez de inventar un botón que no haría nada real; el
 * estado "Selecciona una organización" de arriba no cambia porque su acción
 * real ya existe (el selector del encabezado).
 */
export default function AgentesHerramientasPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const { data: runs, isLoading: loadingRuns, isError: runsError, error: runsErr, refetch: refetchRuns } = useAgentRuns();
  const { data: toolCalls, isLoading: loadingCalls, isError: callsError, error: callsErr, refetch: refetchCalls } = useToolCalls();
  const approveToolCall = useApproveToolCall();
  const denyToolCall = useDenyToolCall();

  const canApprove = Boolean(currentMembership && MEMBERSHIP_ADMIN_ROLES.includes(currentMembership.role));

  // RF-01 (docs/auditoria-2/ronda5-final.md): R5-11 (apps/api) exige
  // `X-Step-Up` (purpose="tool_call.approval") tanto para aprobar como para
  // denegar -- se guarda la tool_call objetivo Y la acción concreta
  // mientras el modal de step-up está abierto; la mutación real solo se
  // dispara tras verificar el código (mismo patrón que
  // TarifasAprobadasPage/RevisionPage).
  const [stepUpTarget, setStepUpTarget] = useState<{ id: string; action: "approve" | "deny" } | null>(null);

  const onVerifiedStepUp = (stepUpToken: string) => {
    if (!stepUpTarget) return;
    const { id, action } = stepUpTarget;
    if (action === "approve") {
      approveToolCall.mutate(
        { id, stepUpToken },
        {
          onSuccess: () => toast.success("tool_call aprobada."),
          onError: (err) => toast.error(describeApiError(err)),
        },
      );
    } else {
      denyToolCall.mutate(
        { id, stepUpToken },
        {
          onSuccess: () => toast.success("tool_call denegada."),
          onError: (err) => toast.error(describeApiError(err)),
        },
      );
    }
  };

  return (
    <div>
      <SectionHeader icon={Bot} title="Agentes y herramientas" description="Corridas de agentes y aprobación humana de tool_calls pendientes de esta organización." />
      {!currentOrgId ? (
        <EmptyState icon={Bot} title="Selecciona una organización" description="Elige una organización en el encabezado para ver sus agentes." />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle level={2}>Tool_calls pendientes de aprobación</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingCalls && <LoadingState label="Cargando tool_calls…" rows={2} />}
              {callsError && <ErrorState message={describeApiError(callsErr)} onRetry={() => refetchCalls()} />}
              {!loadingCalls && !callsError && (!toolCalls || toolCalls.length === 0) && (
                <p className="text-sm text-muted-foreground">Aún no hay tool_calls registradas para esta organización.</p>
              )}
              {!loadingCalls && !callsError && toolCalls && toolCalls.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Herramienta</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Creada (CDMX)</TableHead>
                      {canApprove && <TableHead>Acciones</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {toolCalls.map((tc) => {
                      const cfg = AUTH_STATUS_CONFIG[tc.authorizationStatus];
                      return (
                        <TableRow key={tc.id}>
                          <TableCell className="font-medium">{tc.toolName}</TableCell>
                          <TableCell>
                            <Badge variant={cfg.variant}>{cfg.label}</Badge>
                          </TableCell>
                          <TableCell>{formatDateTimeMx(tc.createdAt)}</TableCell>
                          {canApprove && (
                            <TableCell>
                              {tc.authorizationStatus === "pending" ? (
                                <div className="flex gap-1.5">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="gap-1"
                                    onClick={() => setStepUpTarget({ id: tc.id, action: "approve" })}
                                  >
                                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                    Aprobar
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="gap-1"
                                    onClick={() => setStepUpTarget({ id: tc.id, action: "deny" })}
                                  >
                                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                                    Denegar
                                  </Button>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
              {!canApprove && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Tu rol ({currentMembership?.role ?? "sin rol"}) puede ver las tool_calls pero no aprobarlas/denegarlas
                  — se requiere owner/admin.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle level={2}>Corridas de agentes</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingRuns && <LoadingState label="Cargando corridas…" rows={2} />}
              {runsError && <ErrorState message={describeApiError(runsErr)} onRetry={() => refetchRuns()} />}
              {!loadingRuns && !runsError && (!runs || runs.length === 0) && (
                <EmptyState
                  icon={Bot}
                  title="Aún no hay corridas de agentes"
                  description="Esta pantalla no tiene ninguna acción para iniciar una corrida manualmente: en cuanto la plataforma dispare una para esta organización, aparecerá aquí."
                />
              )}
              {!loadingRuns && !runsError && runs && runs.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agente</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Progreso</TableHead>
                      <TableHead>Inicio (CDMX)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => (
                      <TableRow key={run.id}>
                        <TableCell className="font-medium">{run.agentName}</TableCell>
                        <TableCell>{run.status}</TableCell>
                        <TableCell>
                          {run.completedSteps}/{run.totalSteps}
                        </TableCell>
                        <TableCell>{formatDateTimeMx(run.startedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      <StepUpDialog
        open={stepUpTarget !== null}
        onOpenChange={(open) => {
          if (!open) setStepUpTarget(null);
        }}
        title={
          stepUpTarget?.action === "deny"
            ? "Verificación en dos pasos para denegar la tool_call"
            : "Verificación en dos pasos para aprobar la tool_call"
        }
        description="Aprobar o denegar una tool_call exige confirmar tu identidad con un segundo factor (R5-11)."
        // R5-11: debe coincidir EXACTO con el `purpose` que
        // `POST /agents/tool-calls/:id/approve|deny` exige en su
        // `requireStepUp` (ver apps/api/src/modules/agents/routes.ts).
        purpose="tool_call.approval"
        onVerified={onVerifiedStepUp}
      />
    </div>
  );
}
