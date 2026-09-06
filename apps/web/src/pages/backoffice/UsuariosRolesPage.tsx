import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Users, UserPlus, Trash2 } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useMemberships, useChangeMembershipRole, useRemoveMembership, useInviteMember } from "@/hooks/useMemberships";
import { ORG_ROLES, MEMBERSHIP_ADMIN_ROLES, type OrgRole } from "@/lib/api/schemas";
import { formatDateMx } from "@/lib/datetime";

const inviteSchema = z.object({ email: z.string().email("Correo inválido."), role: z.enum(ORG_ROLES) });
type InviteValues = z.infer<typeof inviteSchema>;

function InviteForm() {
  const invite = useInviteMember();
  const [tokenIssued, setTokenIssued] = useState<string | null>(null);
  const form = useForm<InviteValues>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "", role: "viewer" } });

  const onSubmit = async (values: InviteValues) => {
    try {
      const invitation = await invite.mutateAsync(values);
      setTokenIssued(invitation.token ?? null);
      toast.success(`Invitación creada para ${values.email}.`);
      form.reset({ email: "", role: "viewer" });
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invitar miembro</CardTitle>
        <CardDescription>El token de invitación se muestra una única vez — apps/api no lo persiste en claro ni permite recuperarlo después.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-3">
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Correo</FormLabel>
                  <FormControl>
                    <Input type="email" placeholder="persona@empresa.com" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="role"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Rol</FormLabel>
                  <FormControl>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger aria-label="Rol a invitar" className="w-[160px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ORG_ROLES.map((r) => (
                          <SelectItem key={r} value={r}>
                            {r}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                </FormItem>
              )}
            />
            <Button type="submit" className="gap-1.5" disabled={invite.isPending}>
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              {invite.isPending ? "Invitando…" : "Invitar"}
            </Button>
          </form>
        </Form>
        {tokenIssued && (
          <p className="rounded-lg bg-muted/40 p-2 text-xs text-muted-foreground">
            Token de invitación (guárdalo ahora, no se mostrará de nuevo): <code className="font-mono">{tokenIssued}</code>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function UsuariosRolesPage() {
  const { currentOrgId, currentMembership, user } = useAuth();
  const { data: memberships, isLoading, isError, error, refetch } = useMemberships();
  const changeRole = useChangeMembershipRole();
  const removeMembership = useRemoveMembership();
  const canManage = Boolean(currentMembership && MEMBERSHIP_ADMIN_ROLES.includes(currentMembership.role));

  return (
    <div>
      <SectionHeader icon={Users} title="Usuarios y roles" description="Cuentas de acceso y roles asignados dentro de la organización activa." />

      {!currentOrgId ? (
        <EmptyState icon={Users} title="Selecciona una organización" description="Elige una organización en el encabezado para ver sus usuarios y roles." />
      ) : (
        <div className="space-y-6">
          {canManage && <InviteForm />}

          {isLoading && <LoadingState label="Cargando miembros…" />}
          {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
          {!isLoading && !isError && (!memberships || memberships.items.length === 0) && (
            <EmptyState icon={Users} title="Sin miembros" description="Esta organización todavía no tiene miembros activos." />
          )}
          {!isLoading && !isError && memberships && memberships.items.length > 0 && (
            <Card>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Correo</TableHead>
                      <TableHead>Nombre</TableHead>
                      <TableHead>Rol</TableHead>
                      <TableHead>Estado</TableHead>
                      <TableHead>Desde</TableHead>
                      {canManage && <TableHead>Acciones</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {memberships.items.map((m) => {
                      const isSelf = m.userId === user?.id;
                      return (
                        <TableRow key={m.userId}>
                          <TableCell className="font-medium">{m.email}</TableCell>
                          <TableCell>{m.fullName ?? "—"}</TableCell>
                          <TableCell>
                            {canManage ? (
                              <Select
                                value={m.role}
                                onValueChange={(value) => {
                                  changeRole.mutate(
                                    { userId: m.userId, role: value as OrgRole },
                                    { onError: (err) => toast.error(describeApiError(err)), onSuccess: () => toast.success("Rol actualizado.") },
                                  );
                                }}
                              >
                                <SelectTrigger aria-label={`Rol de ${m.email}`} className="w-[140px]">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {ORG_ROLES.map((r) => (
                                    <SelectItem key={r} value={r}>
                                      {r}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            ) : (
                              <Badge variant="outline">{m.role}</Badge>
                            )}
                          </TableCell>
                          <TableCell>{m.status}</TableCell>
                          <TableCell>{formatDateMx(m.joinedAt)}</TableCell>
                          {canManage && (
                            <TableCell>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={`Eliminar a ${m.email}`}
                                disabled={isSelf || removeMembership.isPending}
                                title={isSelf ? "No puedes eliminarte a ti mismo desde aquí" : undefined}
                                onClick={() => {
                                  removeMembership.mutate(m.userId, {
                                    onError: (err) => toast.error(describeApiError(err)),
                                    onSuccess: () => toast.success("Miembro eliminado."),
                                  });
                                }}
                              >
                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                              </Button>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
