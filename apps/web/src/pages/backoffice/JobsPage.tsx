import { useState } from "react";
import { ListTodo, RotateCw } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { describeApiError } from "@/hooks/useAuth";
import { useAdminJobs, useRetryAdminJob } from "@/hooks/useAdmin";
import { formatDateTimeMx } from "@/lib/datetime";

const STATUS_OPTIONS = ["queued", "running", "succeeded", "failed", "dead_letter"] as const;

/** Back office / superadmin: jobs de la cola real, con reintentar. */
export default function JobsPage() {
  const [status, setStatus] = useState<string>("todos");
  const { data: jobs, isLoading, isError, error, refetch } = useAdminJobs(status === "todos" ? undefined : status);
  const retryJob = useRetryAdminJob();

  return (
    <div>
      <SectionHeader icon={ListTodo} title="Jobs" description="Cola de trabajos reales de la plataforma, con reintentar (solo superadmin)." />
      <div className="mb-4">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger aria-label="Filtrar por estado" className="w-[220px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos los estados</SelectItem>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isLoading && <LoadingState label="Cargando jobs…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && (!jobs || jobs.length === 0) && (
        <EmptyState icon={ListTodo} title="Sin jobs para este filtro" description="No hay trabajos encolados que coincidan con el estado seleccionado." />
      )}
      {!isLoading && !isError && jobs && jobs.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Estado</TableHead>
                  <TableHead>Intentos</TableHead>
                  <TableHead>Último error</TableHead>
                  <TableHead>Próxima corrida (CDMX)</TableHead>
                  <TableHead>Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="font-medium">{job.kind}</TableCell>
                    <TableCell>
                      <Badge variant={job.status === "failed" || job.status === "dead_letter" ? "destructive" : job.status === "succeeded" ? "success" : "secondary"}>
                        {job.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {job.attempts}/{job.maxAttempts}
                    </TableCell>
                    <TableCell className="max-w-xs truncate" title={job.lastError ?? undefined}>
                      {job.lastError ?? "—"}
                    </TableCell>
                    <TableCell>{formatDateTimeMx(job.nextRunAt)}</TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        disabled={retryJob.isPending}
                        onClick={() =>
                          retryJob.mutate(job.id, {
                            onSuccess: () => toast.success("Job reencolado."),
                            onError: (err) => toast.error(describeApiError(err)),
                          })
                        }
                      >
                        <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
                        Reintentar
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
