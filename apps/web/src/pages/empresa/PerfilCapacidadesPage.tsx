import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { IdCard, Plus, Trash2 } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useCompanyProfile, useSaveCompanyProfile, useCapabilities, useCreateCapability, useDeleteCapability } from "@/hooks/useCompany";
import { MEMBERSHIP_ADMIN_ROLES, WRITE_ROLES } from "@/lib/api/schemas";

const profileSchema = z.object({
  legalName: z.string().min(1, "La razón social es obligatoria."),
  tradeName: z.string().optional(),
  taxId: z.string().optional(),
  description: z.string().optional(),
  sector: z.string().optional(),
  website: z.string().optional(),
});
type ProfileValues = z.infer<typeof profileSchema>;

function PerfilForm() {
  const { currentMembership } = useAuth();
  const { data: profile, isLoading, isError, error, refetch } = useCompanyProfile();
  const saveProfile = useSaveCompanyProfile();
  const canEdit = Boolean(currentMembership && MEMBERSHIP_ADMIN_ROLES.includes(currentMembership.role));

  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: { legalName: "", tradeName: "", taxId: "", description: "", sector: "", website: "" },
  });

  useEffect(() => {
    if (profile) {
      form.reset({
        legalName: profile.legalName,
        tradeName: profile.tradeName ?? "",
        taxId: profile.taxId ?? "",
        description: profile.description ?? "",
        sector: profile.sector ?? "",
        website: profile.website ?? "",
      });
    }
  }, [profile, form]);

  if (isLoading) return <LoadingState label="Cargando perfil de empresa…" />;
  if (isError) return <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />;

  const onSubmit = async (values: ProfileValues) => {
    try {
      await saveProfile.mutateAsync({
        legalName: values.legalName,
        tradeName: values.tradeName || undefined,
        taxId: values.taxId || undefined,
        description: values.description || undefined,
        sector: values.sector || undefined,
        website: values.website || undefined,
      });
      toast.success("Perfil de empresa guardado.");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Perfil de la empresa</CardTitle>
        <CardDescription>
          {profile ? "Datos reales capturados en la organización activa." : "Aún no hay perfil capturado para esta organización."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!canEdit && (
          <p className="mb-4 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Tu rol ({currentMembership?.role ?? "sin rol"}) puede ver el perfil pero no editarlo — solo owner/admin
            pueden guardar cambios (la API lo exige igual, esto solo evita un envío que sería rechazado).
          </p>
        )}
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="legalName"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Razón social</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={!canEdit} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="tradeName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre comercial</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={!canEdit} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="taxId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>RFC</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={!canEdit} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="sector"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Sector</FormLabel>
                  <FormControl>
                    <Input {...field} disabled={!canEdit} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="website"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Sitio web</FormLabel>
                  <FormControl>
                    <Input type="url" placeholder="https://…" {...field} disabled={!canEdit} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Descripción</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} disabled={!canEdit} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {canEdit && (
              <div className="sm:col-span-2">
                <Button type="submit" disabled={saveProfile.isPending}>
                  {saveProfile.isPending ? "Guardando…" : "Guardar perfil"}
                </Button>
              </div>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

const capabilitySchema = z.object({
  name: z.string().min(1, "El nombre es obligatorio."),
  category: z.string().optional(),
});
type CapabilityValues = z.infer<typeof capabilitySchema>;

function CapacidadesSection() {
  const { currentMembership } = useAuth();
  const { data: capabilities, isLoading, isError, error, refetch } = useCapabilities();
  const createCapability = useCreateCapability();
  const deleteCapability = useDeleteCapability();
  const canWrite = Boolean(currentMembership && WRITE_ROLES.includes(currentMembership.role));

  const form = useForm<CapabilityValues>({ resolver: zodResolver(capabilitySchema), defaultValues: { name: "", category: "" } });

  const onSubmit = async (values: CapabilityValues) => {
    try {
      await createCapability.mutateAsync({ name: values.name, category: values.category || undefined });
      form.reset();
      toast.success("Capacidad agregada.");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle level={2}>Capacidades</CardTitle>
        <CardDescription>Capacidades técnicas reales de la organización (usadas por el matching de relevancia).</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading && <LoadingState label="Cargando capacidades…" rows={2} />}
        {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
        {!isLoading && !isError && (
          <>
            {capabilities && capabilities.length > 0 ? (
              <ul className="mb-4 flex flex-wrap gap-2">
                {capabilities.map((cap) => (
                  <li key={cap.id}>
                    <Badge variant="secondary" className="gap-1.5 pr-1">
                      {cap.name}
                      {cap.category && <span className="text-muted-foreground">· {cap.category}</span>}
                      {canWrite && (
                        <button
                          type="button"
                          aria-label={`Eliminar capacidad ${cap.name}`}
                          className="ml-1 rounded-full p-0.5 hover:bg-destructive/20"
                          onClick={() => deleteCapability.mutate(cap.id)}
                        >
                          <Trash2 className="h-3 w-3" aria-hidden="true" />
                        </button>
                      )}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-4 text-sm text-muted-foreground">Aún no hay capacidades registradas.</p>
            )}
            {canWrite ? (
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-2">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nombre</FormLabel>
                        <FormControl>
                          <Input placeholder="p. ej. Desarrollo de software" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="category"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Categoría (opcional)</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                      </FormItem>
                    )}
                  />
                  <Button type="submit" size="sm" className="gap-1.5" disabled={createCapability.isPending}>
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    Agregar
                  </Button>
                </form>
              </Form>
            ) : (
              <p className="text-xs text-muted-foreground">
                Tu rol ({currentMembership?.role ?? "sin rol"}) no puede agregar capacidades.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default function PerfilCapacidadesPage() {
  const { currentOrgId } = useAuth();

  return (
    <div>
      <SectionHeader
        icon={IdCard}
        title="Perfil y capacidades"
        description="Perfil real de la empresa: datos generales, sector y capacidades técnicas usadas por el matching."
      />
      {!currentOrgId ? (
        <EmptyState
          icon={IdCard}
          title="Selecciona una organización"
          description="Elige una organización en el encabezado para ver y editar su perfil de empresa."
        />
      ) : (
        <div className="space-y-6">
          <PerfilForm />
          <CapacidadesSection />
        </div>
      )}
    </div>
  );
}
