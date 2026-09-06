import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Tag, Check, X, Plus } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useRates, useProposeRate, useApproveRate, useRejectRate } from "@/hooks/useCompany";
import { ApiError } from "@/lib/api/http";
import { MEMBERSHIP_ADMIN_ROLES, WRITE_ROLES, type Rate } from "@/lib/api/schemas";

// WI-04 (docs/auditoria-2/web-integrado.md): un 409 real de la API significa
// que la tarifa ya cambió de estado entre que se pintó la fila y que se
// hizo clic (otra persona la decidió primero, o un doble clic que sí llegó
// a red antes de que el primero deshabilitara el botón) — se distingue de
// cualquier otro error con un mensaje honesto y específico, y se refresca
// la lista para que la UI deje de mostrar el estado ya obsoleto.
function describeRateActionError(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) {
    return "Esta tarifa ya cambió de estado (alguien más la aprobó o rechazó, o el cambio ya se había aplicado). Se actualizó la lista con el estado real.";
  }
  return describeApiError(err);
}

const RATE_STATUS_CONFIG: Record<Rate["status"], { label: string; variant: "success" | "secondary" | "outline" }> = {
  draft: { label: "Propuesta (borrador)", variant: "secondary" },
  approved: { label: "Aprobada", variant: "success" },
  archived: { label: "Rechazada/archivada", variant: "outline" },
};

const rateSchema = z.object({
  itemCode: z.string().min(1, "El código es obligatorio."),
  description: z.string().min(1, "La descripción es obligatoria."),
  unitPrice: z.coerce.number().min(0, "El precio no puede ser negativo."),
});
type RateValues = z.infer<typeof rateSchema>;

export default function TarifasAprobadasPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const { data: rates, isLoading, isError, error, refetch } = useRates();
  const proposeRate = useProposeRate();
  const approveRate = useApproveRate();
  const rejectRate = useRejectRate();

  const canPropose = Boolean(currentMembership && WRITE_ROLES.includes(currentMembership.role));
  const canApprove = Boolean(currentMembership && MEMBERSHIP_ADMIN_ROLES.includes(currentMembership.role));

  const form = useForm<RateValues>({ resolver: zodResolver(rateSchema), defaultValues: { itemCode: "", description: "", unitPrice: 0 } });

  // WI-06 (docs/auditoria-2/reverificacion-final-integrada.md): el guard
  // anterior (`disabled` derivado de `approveRate.isPending`/`rejectRate.isPending`)
  // solo cierra la ventana de doble clic DESPUÉS de que React confirme el
  // re-render que sigue a `mutate()` — un doble clic físico verdaderamente
  // simultáneo puede pasar el chequeo de "actionability" del navegador antes
  // de que ese re-render ocurra, y ambos clics llegan a disparar la mutación
  // (servidor sigue siendo la barrera real vía WI-04, pero el cliente debía
  // cerrar la ventana). `pendingRatesRef` es un guard SÍNCRONO: se comprueba
  // y se fija ANTES de llamar a `mutate()`, en la misma ejecución síncrona
  // del handler de cada clic — no depende de ningún ciclo de render. El
  // `useState` (`submittingAction`) solo maneja el `disabled` visual y el
  // texto del botón; la barrera real es el `useRef`.
  const pendingRatesRef = useRef<Record<string, boolean>>({});
  const [submittingAction, setSubmittingAction] = useState<Record<string, "approve" | "reject">>({});

  const handleRateAction = (rateId: string, action: "approve" | "reject") => {
    if (pendingRatesRef.current[rateId]) return;
    pendingRatesRef.current[rateId] = true;
    setSubmittingAction((prev) => ({ ...prev, [rateId]: action }));

    const mutation = action === "approve" ? approveRate : rejectRate;
    const successMessage = action === "approve" ? "Tarifa aprobada." : "Tarifa rechazada.";
    mutation.mutate(rateId, {
      onSuccess: () => toast.success(successMessage),
      onError: (err) => toast.error(describeRateActionError(err)),
      onSettled: () => {
        pendingRatesRef.current[rateId] = false;
        setSubmittingAction((prev) => {
          const next = { ...prev };
          delete next[rateId];
          return next;
        });
      },
    });
  };

  const onSubmit = async (values: RateValues) => {
    try {
      await proposeRate.mutateAsync(values);
      form.reset();
      toast.success("Tarifa propuesta (queda en borrador hasta que owner/admin la apruebe).");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <div>
      <SectionHeader
        icon={Tag}
        title="Tarifas aprobadas"
        description="Flujo real: cualquier rol de escritura propone una tarifa (queda en borrador); solo owner/admin la aprueba o la rechaza."
      />
      {!currentOrgId ? (
        <EmptyState icon={Tag} title="Selecciona una organización" description="Elige una organización en el encabezado para ver sus tarifas." />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle level={2}>Proponer tarifa</CardTitle>
              <CardDescription>
                {canPropose
                  ? "Se crea en estado 'borrador' — no es válida hasta que un owner/admin la apruebe."
                  : `Tu rol (${currentMembership?.role ?? "sin rol"}) no puede proponer tarifas.`}
              </CardDescription>
            </CardHeader>
            {canPropose && (
              <CardContent>
                <Form {...form}>
                  <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-3">
                    <FormField
                      control={form.control}
                      name="itemCode"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Código</FormLabel>
                          <FormControl>
                            <Input placeholder="p. ej. SRV-001" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="description"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Descripción</FormLabel>
                          <FormControl>
                            <Input {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="unitPrice"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Precio unitario (MXN)</FormLabel>
                          <FormControl>
                            <Input type="number" step="0.01" min="0" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <Button type="submit" className="gap-1.5" disabled={proposeRate.isPending}>
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      {proposeRate.isPending ? "Proponiendo…" : "Proponer"}
                    </Button>
                  </form>
                </Form>
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle level={2}>Tarifas de la organización</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading && <LoadingState label="Cargando tarifas…" />}
              {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
              {!isLoading && !isError && (!rates || rates.length === 0) && (
                <EmptyState icon={Tag} title="Aún no hay tarifas" description="Propón la primera tarifa para iniciar el flujo de aprobación." />
              )}
              {!isLoading && !isError && rates && rates.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Código</TableHead>
                      <TableHead>Descripción</TableHead>
                      <TableHead>Precio</TableHead>
                      <TableHead>Estado</TableHead>
                      {canApprove && <TableHead>Acciones</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rates.map((rate) => {
                      const status = RATE_STATUS_CONFIG[rate.status];
                      return (
                        <TableRow key={rate.id}>
                          <TableCell className="font-medium">{rate.itemCode}</TableCell>
                          <TableCell>{rate.description}</TableCell>
                          <TableCell>
                            {rate.unitPrice.toLocaleString("es-MX", { style: "currency", currency: rate.currency || "MXN" })}
                          </TableCell>
                          <TableCell>
                            <Badge variant={status.variant}>{status.label}</Badge>
                          </TableCell>
                          {canApprove && (
                            <TableCell>
                              {rate.status === "draft" ? (
                                (() => {
                                  // WI-04/WI-06: deshabilitado por FILA (no
                                  // toda la tabla) mientras SU propia tarifa
                                  // tiene una decisión en curso —
                                  // `submittingAction[rate.id]` se fija de
                                  // forma síncrona en `handleRateAction`
                                  // (ver arriba), así que otra fila puede
                                  // seguir operando en paralelo sin
                                  // bloquearse por esta.
                                  const pendingAction = submittingAction[rate.id];
                                  const isThisRatePending = Boolean(pendingAction);
                                  return (
                                    <div className="flex gap-1.5">
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        className="gap-1"
                                        disabled={isThisRatePending}
                                        onClick={() => handleRateAction(rate.id, "approve")}
                                      >
                                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                        {pendingAction === "approve" ? "Aprobando…" : "Aprobar"}
                                      </Button>
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className="gap-1"
                                        disabled={isThisRatePending}
                                        onClick={() => handleRateAction(rate.id, "reject")}
                                      >
                                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                                        {pendingAction === "reject" ? "Rechazando…" : "Rechazar"}
                                      </Button>
                                    </div>
                                  );
                                })()
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
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
