import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AlertOctagon, Plus, Check } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { describeApiError } from "@/hooks/useAuth";
import { useAdminIncidents, useCreateAdminIncident, useResolveAdminIncident } from "@/hooks/useAdmin";
import { INCIDENT_SEVERITIES } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

const SEVERITY_VARIANT: Record<string, "outline" | "warning" | "destructive"> = {
  low: "outline",
  medium: "warning",
  high: "destructive",
  critical: "destructive",
};

const incidentSchema = z.object({
  title: z.string().min(1, "El título es obligatorio."),
  severity: z.enum(INCIDENT_SEVERITIES),
});
type IncidentValues = z.infer<typeof incidentSchema>;

/** Back office / superadmin: incidentes de plataforma, con registrar y resolver. */
export default function IncidentesPage() {
  const { data: incidents, isLoading, isError, error, refetch } = useAdminIncidents();
  const createIncident = useCreateAdminIncident();
  const resolveIncident = useResolveAdminIncident();

  const form = useForm<IncidentValues>({ resolver: zodResolver(incidentSchema), defaultValues: { title: "", severity: "low" } });

  const onSubmit = async (values: IncidentValues) => {
    try {
      await createIncident.mutateAsync(values);
      form.reset();
      toast.success("Incidente registrado.");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <div>
      <SectionHeader icon={AlertOctagon} title="Incidentes" description="Incidentes de plataforma (solo superadmin)." />
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle level={2}>Registrar incidente</CardTitle>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-3">
                <FormField
                  control={form.control}
                  name="title"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Título</FormLabel>
                      <FormControl>
                        <Input {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="severity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Severidad</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <FormControl>
                          <SelectTrigger className="w-[160px]">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {INCIDENT_SEVERITIES.map((s) => (
                            <SelectItem key={s} value={s}>
                              {s}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </FormItem>
                  )}
                />
                <Button type="submit" className="gap-1.5" disabled={createIncident.isPending}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  Registrar
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>

        {isLoading && <LoadingState label="Cargando incidentes…" />}
        {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
        {!isLoading && !isError && (!incidents || incidents.length === 0) && (
          <EmptyState icon={AlertOctagon} title="Sin incidentes registrados" description="No hay incidentes de plataforma abiertos ni resueltos." />
        )}
        {!isLoading && !isError && incidents && incidents.length > 0 && (
          <Card>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Título</TableHead>
                    <TableHead>Severidad</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Creado (CDMX)</TableHead>
                    <TableHead>Acciones</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {incidents.map((inc) => (
                    <TableRow key={inc.id}>
                      <TableCell className="font-medium">{inc.title}</TableCell>
                      <TableCell>
                        <Badge variant={SEVERITY_VARIANT[inc.severity] ?? "outline"}>{inc.severity}</Badge>
                      </TableCell>
                      <TableCell>{inc.status}</TableCell>
                      <TableCell>{formatDateTimeMx(inc.createdAt)}</TableCell>
                      <TableCell>
                        {inc.status !== "resolved" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="gap-1.5"
                            onClick={() =>
                              resolveIncident.mutate(inc.id, {
                                onSuccess: () => toast.success("Incidente resuelto."),
                                onError: (err) => toast.error(describeApiError(err)),
                              })
                            }
                          >
                            <Check className="h-3.5 w-3.5" aria-hidden="true" />
                            Resolver
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
