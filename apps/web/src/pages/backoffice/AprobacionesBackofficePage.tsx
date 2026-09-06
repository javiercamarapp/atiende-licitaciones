import { ShieldCheck, Check, X } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { describeApiError } from "@/hooks/useAuth";
import { useAdminApprovals, useApproveAdminToolCall, useDenyAdminToolCall } from "@/hooks/useAdmin";
import { formatDateTimeMx } from "@/lib/datetime";
import { toast } from "@/components/ui/sonner";

/**
 * Back office / superadmin: tool_calls pendientes de TODAS las
 * organizaciones (`GET /admin/approvals`). Desde la ronda 4 de apps/api,
 * `POST /admin/tool-calls/:id/approve|deny` decide de verdad CROSS-ORG
 * (gateado por `app.requireSuperadmin`, sin necesidad de `X-Org-Id` ni de
 * ser owner/admin de la organización dueña) — esta pantalla dejó de ser de
 * solo lectura.
 */
export default function AprobacionesBackofficePage() {
  const { data: approvals, isLoading, isError, error, refetch } = useAdminApprovals();
  const approve = useApproveAdminToolCall();
  const deny = useDenyAdminToolCall();

  return (
    <div>
      <SectionHeader icon={ShieldCheck} title="Aprobaciones" description="Tool_calls pendientes de todas las organizaciones (solo superadmin)." />
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Aprobación cross-org real</CardTitle>
          <CardDescription>
            Aprobar/denegar aquí actúa directamente sobre la organización dueña de la tool_call, sin necesidad de
            cambiar de organización ni de ser owner/admin de ella — reservado a superadmin.
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
                  <TableHead>Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {approvals.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.orgName}</TableCell>
                    <TableCell>{a.toolName}</TableCell>
                    <TableCell>{formatDateTimeMx(a.createdAt)}</TableCell>
                    <TableCell className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="gap-1.5"
                        disabled={approve.isPending || deny.isPending}
                        onClick={() => {
                          approve.mutate(a.id, {
                            onSuccess: () => toast.success("Tool_call aprobada."),
                            onError: (err) => toast.error(describeApiError(err)),
                          });
                        }}
                      >
                        <Check className="h-4 w-4" aria-hidden="true" />
                        Aprobar
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        className="gap-1.5"
                        disabled={approve.isPending || deny.isPending}
                        onClick={() => {
                          deny.mutate(a.id, {
                            onSuccess: () => toast.success("Tool_call denegada."),
                            onError: (err) => toast.error(describeApiError(err)),
                          });
                        }}
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                        Denegar
                      </Button>
                    </TableCell>
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
