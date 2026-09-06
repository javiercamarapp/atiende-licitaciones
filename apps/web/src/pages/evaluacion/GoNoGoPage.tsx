import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Scale, ThumbsUp, ThumbsDown } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useTenders } from "@/hooks/useTenders";
import { useTenderMatch } from "@/hooks/useMatching";
import { useGoNoGoDecisions, useCreateGoNoGoDecision } from "@/hooks/useGoNoGo";
import { GO_NO_GO_ROLES } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

const decisionSchema = z.object({
  decision: z.enum(["go", "no_go"]),
  reasons: z.string().min(1, "Indica al menos un motivo (uno por línea)."),
});
type DecisionValues = z.infer<typeof decisionSchema>;

export default function GoNoGoPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const { data: tendersPage, isLoading: loadingTenders, isError: tendersError, error: tendersErr, refetch: refetchTenders } = useTenders({ limit: 50 });
  const [selectedTenderId, setSelectedTenderId] = useState<string | null>(null);

  const { data: match } = useTenderMatch(selectedTenderId);
  const { data: decisions, isLoading: loadingDecisions, isError: decisionsError, error: decisionsErr, refetch: refetchDecisions } = useGoNoGoDecisions(selectedTenderId);
  const createDecision = useCreateGoNoGoDecision(selectedTenderId);

  const canDecide = Boolean(currentMembership && GO_NO_GO_ROLES.includes(currentMembership.role));

  const form = useForm<DecisionValues>({ resolver: zodResolver(decisionSchema), defaultValues: { decision: "go", reasons: "" } });

  const onSubmit = async (values: DecisionValues) => {
    try {
      await createDecision.mutateAsync({
        decision: values.decision,
        reasons: values.reasons.split("\n").map((r) => r.trim()).filter(Boolean),
      });
      form.reset({ decision: "go", reasons: "" });
      toast.success("Decisión Go/No-Go registrada.");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <div>
      <SectionHeader
        icon={Scale}
        title="Go/No-Go"
        description="Decisión real por convocatoria, con motivos obligatorios y rol restringido: writer nunca decide."
      />
      {!currentOrgId ? (
        <EmptyState icon={Scale} title="Selecciona una organización" description="Elige una organización en el encabezado para decidir sobre sus convocatorias." />
      ) : (
        <div className="space-y-6">
          {loadingTenders && <LoadingState label="Cargando convocatorias…" rows={2} />}
          {tendersError && <ErrorState message={describeApiError(tendersErr)} onRetry={() => refetchTenders()} />}
          {!loadingTenders && !tendersError && (!tendersPage || tendersPage.items.length === 0) && (
            <EmptyState icon={Scale} title="Sin convocatorias" description="No hay convocatorias todavía para decidir Go/No-Go." />
          )}
          {!loadingTenders && !tendersError && tendersPage && tendersPage.items.length > 0 && (
            <Select value={selectedTenderId ?? undefined} onValueChange={setSelectedTenderId}>
              <SelectTrigger aria-label="Convocatoria" className="w-full sm:w-[420px]">
                <SelectValue placeholder="Selecciona una convocatoria" />
              </SelectTrigger>
              <SelectContent>
                {tendersPage.items.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {selectedTenderId && (
            <>
              {match && (
                <Card>
                  <CardHeader>
                    <CardTitle level={2}>Contexto de matching</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    <Badge variant="secondary">Relevancia {match.relevance.score}/100</Badge>
                    <Badge variant={match.eligibility.status === "cumple" ? "success" : match.eligibility.status === "no_cumple" ? "destructive" : "outline"}>
                      Elegibilidad: {match.eligibility.status === "no_evaluable" ? "no evaluable" : match.eligibility.status}
                    </Badge>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardHeader>
                  <CardTitle level={2}>Historial de decisiones</CardTitle>
                </CardHeader>
                <CardContent>
                  {loadingDecisions && <LoadingState label="Cargando historial…" rows={2} />}
                  {decisionsError && <ErrorState message={describeApiError(decisionsErr)} onRetry={() => refetchDecisions()} />}
                  {!loadingDecisions && !decisionsError && (!decisions || decisions.length === 0) && (
                    <p className="text-sm text-muted-foreground">Aún no hay decisiones registradas para esta convocatoria.</p>
                  )}
                  {!loadingDecisions && !decisionsError && decisions && decisions.length > 0 && (
                    <ul className="space-y-3">
                      {decisions.map((d) => (
                        <li key={d.id} className="rounded-xl border border-border p-3">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <Badge variant={d.decision === "go" ? "success" : "destructive"}>{d.decision === "go" ? "Go" : "No-Go"}</Badge>
                            <span className="text-xs text-muted-foreground">{formatDateTimeMx(d.decidedAt)}</span>
                          </div>
                          <ul className="list-inside list-disc text-sm text-muted-foreground">
                            {d.reasons.map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle level={2}>Registrar decisión</CardTitle>
                </CardHeader>
                <CardContent>
                  {!canDecide && (
                    <p className="mb-4 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                      Tu rol ({currentMembership?.role ?? "sin rol"}) no puede decidir Go/No-Go — se requiere
                      reviewer/analyst/admin/owner (la API lo exige igual; esto solo evita un envío que sería
                      rechazado).
                    </p>
                  )}
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                      <FormField
                        control={form.control}
                        name="decision"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Decisión</FormLabel>
                            <FormControl>
                              <div className="flex gap-2">
                                <Button
                                  type="button"
                                  variant={field.value === "go" ? "default" : "outline"}
                                  className="gap-1.5"
                                  disabled={!canDecide}
                                  onClick={() => field.onChange("go")}
                                >
                                  <ThumbsUp className="h-4 w-4" aria-hidden="true" />
                                  Go
                                </Button>
                                <Button
                                  type="button"
                                  variant={field.value === "no_go" ? "default" : "outline"}
                                  className="gap-1.5"
                                  disabled={!canDecide}
                                  onClick={() => field.onChange("no_go")}
                                >
                                  <ThumbsDown className="h-4 w-4" aria-hidden="true" />
                                  No-Go
                                </Button>
                              </div>
                            </FormControl>
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name="reasons"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Motivos (uno por línea)</FormLabel>
                            <FormControl>
                              <Textarea rows={3} disabled={!canDecide} {...field} />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      {canDecide && (
                        <Button type="submit" disabled={createDecision.isPending}>
                          {createDecision.isPending ? "Guardando…" : "Registrar decisión"}
                        </Button>
                      )}
                    </form>
                  </Form>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}
    </div>
  );
}
