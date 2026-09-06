import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Send, ShieldAlert, CalendarCheck } from "lucide-react";

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
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useSubmission, useDeclareSubmission } from "@/hooks/useExpediente";
import { WRITE_ROLES } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const declareSchema = z.object({
  submittedAt: z.string().min(1, "Indica la fecha y hora de presentación."),
  notes: z.string().optional(),
});
type DeclareValues = z.infer<typeof declareSchema>;

function DeclareForm({ tenderId }: { tenderId: string }) {
  const declare = useDeclareSubmission(tenderId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ackFile, setAckFile] = useState<File | null>(null);
  const form = useForm<DeclareValues>({ resolver: zodResolver(declareSchema), defaultValues: { submittedAt: "", notes: "" } });

  const onSubmit = async (values: DeclareValues) => {
    try {
      const acknowledgementContentBase64 = ackFile ? await fileToBase64(ackFile) : undefined;
      await declare.mutateAsync({
        submittedAt: new Date(values.submittedAt).toISOString(),
        notes: values.notes || undefined,
        acknowledgementFilename: ackFile?.name,
        acknowledgementContentBase64,
      });
      toast.success("Presentación declarada.");
      form.reset({ submittedAt: "", notes: "" });
      setAckFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Declarar presentación</CardTitle>
        <CardDescription>
          Registra que TÚ presentaste la propuesta (fecha y, opcionalmente, el acuse que TÚ recibiste del portal
          oficial). Esta plataforma nunca presenta ni firma nada en tu nombre.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="submittedAt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Fecha y hora de presentación</FormLabel>
                  <FormControl>
                    <Input type="datetime-local" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notas (opcional)</FormLabel>
                  <FormControl>
                    <Textarea rows={2} {...field} />
                  </FormControl>
                </FormItem>
              )}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="ack-file" className="text-sm font-medium text-foreground">
                Acuse recibido (opcional)
              </label>
              <input
                id="ack-file"
                ref={fileInputRef}
                type="file"
                onChange={(e) => setAckFile(e.target.files?.[0] ?? null)}
                className="text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
              />
            </div>
            <Button type="submit" className="gap-1.5" disabled={declare.isPending}>
              <Send className="h-4 w-4" aria-hidden="true" />
              {declare.isPending ? "Guardando…" : "Declarar presentación"}
            </Button>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

export default function EntregasPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const [tenderId, setTenderId] = useState<string | null>(null);
  const canWrite = Boolean(currentMembership && WRITE_ROLES.includes(currentMembership.role));
  const { data: submission, isLoading, isError, error, refetch } = useSubmission(tenderId);

  return (
    <div>
      <SectionHeader icon={Send} title="Entregas" description="Declaración de presentación de la propuesta por el propio usuario." />

      <Card className="mb-6 border-warning/40 bg-warning/5">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" strokeWidth={1.75} />
          <div>
            <CardTitle className="text-base">El sistema nunca envía ni firma nada</CardTitle>
            <CardDescription>Presentas y firmas tú mismo en el portal oficial. Aquí solo registras que ya lo hiciste.</CardDescription>
          </div>
        </CardHeader>
      </Card>

      {!currentOrgId ? (
        <EmptyState icon={Send} title="Selecciona una organización" description="Elige una organización en el encabezado para declarar una presentación." />
      ) : (
        <div className="space-y-6">
          <TenderSelect value={tenderId} onChange={setTenderId} />

          {tenderId && (
            <>
              {isLoading && <LoadingState label="Cargando presentación…" />}
              {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
              {!isLoading && !isError && submission && (
                <Card>
                  <CardHeader className="flex-row items-center justify-between space-y-0">
                    <CardTitle level={2} className="flex items-center gap-2 text-base">
                      <CalendarCheck className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      Presentación declarada
                    </CardTitle>
                    <Badge variant="success">{submission.status}</Badge>
                  </CardHeader>
                  <CardContent className="space-y-1 text-sm text-muted-foreground">
                    <p>Fecha declarada: {formatDateTimeMx(submission.submittedAt)}</p>
                    <p>Acuse adjunto: {submission.acknowledgementStorageRef ? "Sí" : "No"}</p>
                    {submission.notes && <p>Notas: {submission.notes}</p>}
                  </CardContent>
                </Card>
              )}
              {canWrite && <DeclareForm tenderId={tenderId} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}
