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
import { MEMBERSHIP_ADMIN_ROLES, WRITE_ROLES, type Rate } from "@/lib/api/schemas";

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
                                <div className="flex gap-1.5">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="gap-1"
                                    onClick={() =>
                                      approveRate.mutate(rate.id, {
                                        onSuccess: () => toast.success("Tarifa aprobada."),
                                        onError: (err) => toast.error(describeApiError(err)),
                                      })
                                    }
                                  >
                                    <Check className="h-3.5 w-3.5" aria-hidden="true" />
                                    Aprobar
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    className="gap-1"
                                    onClick={() =>
                                      rejectRate.mutate(rate.id, {
                                        onSuccess: () => toast.success("Tarifa rechazada."),
                                        onError: (err) => toast.error(describeApiError(err)),
                                      })
                                    }
                                  >
                                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                                    Rechazar
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
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
