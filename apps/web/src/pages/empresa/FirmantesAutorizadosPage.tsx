import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Signature, Plus, Trash2 } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useSignatories, useCreateSignatory, useDeleteSignatory } from "@/hooks/useCompany";
import { MEMBERSHIP_ADMIN_ROLES } from "@/lib/api/schemas";
import { formatDateMx } from "@/lib/datetime";

const signatorySchema = z.object({
  fullName: z.string().min(1, "El nombre es obligatorio."),
  roleTitle: z.string().optional(),
  validUntil: z.string().optional(),
});
type SignatoryValues = z.infer<typeof signatorySchema>;

export default function FirmantesAutorizadosPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const { data: signatories, isLoading, isError, error, refetch } = useSignatories();
  const createSignatory = useCreateSignatory();
  const deleteSignatory = useDeleteSignatory();
  const canWrite = Boolean(currentMembership && MEMBERSHIP_ADMIN_ROLES.includes(currentMembership.role));

  const form = useForm<SignatoryValues>({
    resolver: zodResolver(signatorySchema),
    defaultValues: { fullName: "", roleTitle: "", validUntil: "" },
  });

  const onSubmit = async (values: SignatoryValues) => {
    try {
      await createSignatory.mutateAsync({
        fullName: values.fullName,
        roleTitle: values.roleTitle || undefined,
        validUntil: values.validUntil || undefined,
      });
      form.reset();
      toast.success("Firmante agregado.");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <div>
      <SectionHeader
        icon={Signature}
        title="Firmantes autorizados"
        description="Personas con facultad real para firmar en nombre de la empresa (poderes/representación)."
      />
      {!currentOrgId ? (
        <EmptyState icon={Signature} title="Selecciona una organización" description="Elige una organización en el encabezado para ver sus firmantes." />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle level={2}>Firmantes</CardTitle>
            <CardDescription>
              {canWrite
                ? "Solo owner/admin pueden agregar o eliminar firmantes (dato sensible: representación legal)."
                : `Tu rol (${currentMembership?.role ?? "sin rol"}) puede ver los firmantes, pero no editarlos.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading && <LoadingState label="Cargando firmantes…" rows={2} />}
            {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
            {!isLoading && !isError && (!signatories || signatories.length === 0) && (
              <p className="mb-4 text-sm text-muted-foreground">Aún no hay firmantes registrados.</p>
            )}
            {!isLoading && !isError && signatories && signatories.length > 0 && (
              <Table className="mb-4">
                <TableHeader>
                  <TableRow>
                    <TableHead>Nombre</TableHead>
                    <TableHead>Cargo</TableHead>
                    <TableHead>Vigente hasta</TableHead>
                    {canWrite && <TableHead>Acciones</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {signatories.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.fullName}</TableCell>
                      <TableCell>{s.roleTitle ?? "—"}</TableCell>
                      <TableCell>{formatDateMx(s.validUntil)}</TableCell>
                      {canWrite && (
                        <TableCell>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Eliminar firmante ${s.fullName}`}
                            onClick={() => deleteSignatory.mutate(s.id, { onError: (err) => toast.error(describeApiError(err)) })}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {canWrite && (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-3">
                  <FormField
                    control={form.control}
                    name="fullName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nombre completo</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="roleTitle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Cargo (opcional)</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="validUntil"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Vigente hasta (opcional)</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="gap-1.5" disabled={createSignatory.isPending}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Agregar
                  </Button>
                </form>
              </Form>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
