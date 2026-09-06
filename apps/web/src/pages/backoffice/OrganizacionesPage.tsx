import { Building2 } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeApiError } from "@/hooks/useAuth";
import { useAdminOrganizations } from "@/hooks/useAdmin";
import { formatDateMx } from "@/lib/datetime";

/**
 * Back office / superadmin (E10): TODAS las organizaciones de la
 * plataforma, no solo las del usuario actual (`GET /admin/organizations`,
 * gateado por `app.requireSuperadmin`). Un usuario normal recibe 403 real de
 * la API — se muestra tal cual con `<ErrorState/>`, nunca se oculta el
 * enlace de navegación como única barrera de permisos.
 */
export default function OrganizacionesPage() {
  const { data: organizations, isLoading, isError, error, refetch } = useAdminOrganizations();

  return (
    <div>
      <SectionHeader icon={Building2} title="Organizaciones" description="Todas las organizaciones de la plataforma (solo superadmin)." />
      {isLoading && <LoadingState label="Cargando organizaciones…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && (!organizations || organizations.length === 0) && (
        <EmptyState icon={Building2} title="Aún no hay organizaciones registradas" description="Crea la primera organización para empezar a operar en la plataforma." />
      )}
      {!isLoading && !isError && organizations && organizations.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Miembros</TableHead>
                  <TableHead>Creada</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {organizations.map((org) => (
                  <TableRow key={org.id}>
                    <TableCell className="font-medium">{org.name}</TableCell>
                    <TableCell>{org.slug}</TableCell>
                    <TableCell>{org.memberCount}</TableCell>
                    <TableCell>{formatDateMx(org.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
