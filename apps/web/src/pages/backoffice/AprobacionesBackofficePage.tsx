import { ShieldCheck } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeApiError } from "@/hooks/useAuth";
import { useAdminApprovals } from "@/hooks/useAdmin";
import { formatDateTimeMx } from "@/lib/datetime";

/**
 * Back office / superadmin: tool_calls pendientes de TODAS las
 * organizaciones (`GET /admin/approvals`). Es de solo lectura a propósito:
 * la API no ofrece un endpoint de aprobación a nivel superadmin — aprobar o
 * denegar una tool_call exige `X-Org-Id` + rol owner/admin DE ESA
 * organización (`POST /agents/tool-calls/:id/approve|deny`, ver
 * apps/api/src/modules/agents/routes.ts), y un superadmin no
 * necesariamente es miembro de la organización dueña de cada tool_call. Se
 * documenta el flujo real (cambiar a esa organización en el selector y
 * aprobar desde "Agentes y herramientas") en vez de fingir un botón que la
 * API rechazaría con 403.
 */
export default function AprobacionesBackofficePage() {
  const { data: approvals, isLoading, isError, error, refetch } = useAdminApprovals();

  return (
    <div>
      <SectionHeader icon={ShieldCheck} title="Aprobaciones" description="Tool_calls pendientes de todas las organizaciones (solo superadmin)." />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Solo lectura aquí</CardTitle>
          <CardDescription>
            Para aprobar o denegar, cambia a la organización correspondiente en el selector del encabezado y hazlo
            desde "Agentes y herramientas" — aprobar exige ser owner/admin de ESA organización, algo que un superadmin
            no necesariamente es.
          </CardDescription>
        </CardHeader>
      </Card>
      {isLoading && <LoadingState label="Cargando aprobaciones pendientes…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && (!approvals || approvals.length === 0) && (
        <EmptyState icon={ShieldCheck} title="Sin aprobaciones pendientes" description="No hay tool_calls pendientes de aprobación en ninguna organización." />
      )}
      {!isLoading && !isError && approvals && approvals.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organización</TableHead>
                  <TableHead>Herramienta</TableHead>
                  <TableHead>Creada (CDMX)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {approvals.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.orgName}</TableCell>
                    <TableCell>{a.toolName}</TableCell>
                    <TableCell>{formatDateTimeMx(a.createdAt)}</TableCell>
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
