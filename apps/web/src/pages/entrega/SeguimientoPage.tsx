import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Timer, Plus, Scale } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { TenderSelect } from "@/components/expediente/TenderSelect";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { usePostAward, useCreatePostAward, useUpdatePostAward } from "@/hooks/useExpediente";
import { WRITE_ROLES, FOLLOWUP_KINDS, FOLLOWUP_STATUSES, type FollowupKind, type FollowupStatus } from "@/lib/api/schemas";
import { formatDateMx, formatDateTimeMx } from "@/lib/datetime";

const KIND_LABELS: Record<FollowupKind, string> = {
  hito: "Hito",
  garantia: "Garantía",
  facturacion: "Facturación",
  pago: "Pago",
  otro: "Otro",
};

const STATUS_LABELS: Record<FollowupStatus, { label: string; variant: "outline" | "warning" | "success" | "destructive" }> = {
  pending: { label: "Pendiente", variant: "outline" },
  in_progress: { label: "En progreso", variant: "warning" },
  done: { label: "Completado", variant: "success" },
  overdue: { label: "Vencido", variant: "destructive" },
  cancelled: { label: "Cancelado", variant: "outline" },
};

const followupSchema = z.object({
  kind: z.enum(FOLLOWUP_KINDS),
  label: z.string().min(1, "Indica una etiqueta."),
  dueDate: z.string().optional(),
  amount: z.string().optional(),
  notes: z.string().optional(),
  invoiceVerifiedOn: z.string().optional(),
});
type FollowupValues = z.infer<typeof followupSchema>;

function CreateFollowupForm({ tenderId }: { tenderId: string }) {
  const create = useCreatePostAward(tenderId);
  const form = useForm<FollowupValues>({ resolver: zodResolver(followupSchema), defaultValues: { kind: "hito", label: "", dueDate: "", amount: "", notes: "", invoiceVerifiedOn: "" } });
  const kind = form.watch("kind");

  const onSubmit = async (values: FollowupValues) => {
    if (values.kind === "pago" && !values.invoiceVerifiedOn) {
      toast.error('Para kind="pago" indica la fecha en que se verificó la factura (el plazo se calcula, no se declara).');
      return;
    }
    try {
      await create.mutateAsync({
        kind: values.kind,
        label: values.label,
        dueDate: values.kind === "pago" ? undefined : values.dueDate || undefined,
        amount: values.amount ? Number(values.amount) : undefined,
        notes: values.notes || undefined,
        invoiceVerifiedOn: values.kind === "pago" ? values.invoiceVerifiedOn : undefined,
      });
      toast.success("Seguimiento registrado.");
      form.reset({ kind: "hito", label: "", dueDate: "", amount: "", notes: "", invoiceVerifiedOn: "" });
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Registrar seguimiento</CardTitle>
        <CardDescription>
          Para "pago", el plazo se calcula (17 días hábiles, LAASSP Art. 73, o el régimen vigente al momento de la
          convocatoria) a partir de la fecha en que verificaste la factura — nunca se declara una fecha límite a mano.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="kind"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tipo</FormLabel>
                  <FormControl>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger aria-label="Tipo de seguimiento">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FOLLOWUP_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {KIND_LABELS[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="label"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Etiqueta</FormLabel>
                  <FormControl>
                    <Input placeholder="p. ej. Entrega de fianza de cumplimiento" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {kind === "pago" ? (
              <FormField
                control={form.control}
                name="invoiceVerifiedOn"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Fecha en que se verificó la factura</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Fecha límite (opcional)</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Monto (opcional)</FormLabel>
                  <FormControl>
                    <Input type="number" step="any" {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Notas (opcional)</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <div className="sm:col-span-2">
              <Button type="submit" className="gap-1.5" disabled={create.isPending}>
                <Plus className="h-4 w-4" aria-hidden="true" />
                {create.isPending ? "Guardando…" : "Registrar seguimiento"}
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

export default function SeguimientoPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const [tenderId, setTenderId] = useState<string | null>(null);
  const canWrite = Boolean(currentMembership && WRITE_ROLES.includes(currentMembership.role));
  const { data: followups, isLoading, isError, error, refetch } = usePostAward(tenderId);
  const update = useUpdatePostAward(tenderId);

  return (
    <div>
      <SectionHeader icon={Timer} title="Seguimiento post-adjudicación" description="Hitos, garantías, facturación y plazo de pago con régimen legal citado." />

      {!currentOrgId ? (
        <EmptyState icon={Timer} title="Selecciona una organización" description="Elige una organización en el encabezado para ver el seguimiento de sus convocatorias." />
      ) : (
        <div className="space-y-6">
          <TenderSelect value={tenderId} onChange={setTenderId} />

          {tenderId && (
            <>
              {canWrite && <CreateFollowupForm tenderId={tenderId} />}

              {isLoading && <LoadingState label="Cargando seguimiento…" />}
              {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
              {!isLoading && !isError && (!followups || followups.length === 0) && (
                <EmptyState icon={Timer} title="Sin seguimiento registrado" description="Registra hitos, garantías, facturación o pagos de esta convocatoria adjudicada." />
              )}
              {!isLoading && !isError && followups && followups.length > 0 && (
                <ul className="space-y-3">
                  {followups.map((f) => (
                    <li key={f.id}>
                      <Card>
                        <CardContent className="space-y-2 p-4">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <Badge variant="outline" className="mr-2">
                                {KIND_LABELS[f.kind as FollowupKind] ?? f.kind}
                              </Badge>
                              <span className="font-medium text-foreground">{f.label}</span>
                            </div>
                            {canWrite ? (
                              <Select
                                value={f.status}
                                onValueChange={(value) => {
                                  update.mutate({ id: f.id, input: { status: value as FollowupStatus } }, { onError: (err) => toast.error(describeApiError(err)) });
                                }}
                              >
                                <SelectTrigger aria-label={`Estado de "${f.label}"`} className="w-[160px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {FOLLOWUP_STATUSES.map((s) => (
                                    <SelectItem key={s} value={s}>
                                      {STATUS_LABELS[s].label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge variant={STATUS_LABELS[f.status as FollowupStatus]?.variant ?? "outline"}>{STATUS_LABELS[f.status as FollowupStatus]?.label ?? f.status}</Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground">
                            {f.dueDate ? `Vence: ${formatDateMx(f.dueDate)}` : "Sin fecha límite"}
                            {f.amount != null ? ` · Monto: ${f.amount.toLocaleString("es-MX", { style: "currency", currency: "MXN" })}` : ""}
                          </p>
                          {f.notes && <p className="text-sm text-muted-foreground">{f.notes}</p>}
                          {f.calendarNote && (
                            <p className="flex items-start gap-1.5 rounded-lg bg-muted/40 p-2 text-xs text-muted-foreground">
                              <Scale className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              {f.calendarNote}
                            </p>
                          )}
                          {f.legalRegime && (
                            <p className="text-xs text-muted-foreground">
                              Régimen legal: {f.legalRegime.law} {f.legalRegime.article} (DOF {f.legalRegime.dofDate}) — {f.legalRegime.days}{" "}
                              {f.legalRegime.unit === "dias_habiles" ? "días hábiles" : "días naturales"}. {f.legalRegime.reason}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">Registrado {formatDateTimeMx(f.createdAt)}</p>
                        </CardContent>
                      </Card>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
