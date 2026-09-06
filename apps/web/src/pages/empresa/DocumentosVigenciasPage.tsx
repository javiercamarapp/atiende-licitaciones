import { useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FileClock, Trash2, Upload } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useDocuments, useUploadDocument, useDeleteDocument } from "@/hooks/useCompany";
import { MEMBERSHIP_ADMIN_ROLES, type CompanyDocument } from "@/lib/api/schemas";
import { formatDateMx } from "@/lib/datetime";
import { DOCUMENT_ACCEPT_ATTR, validateDocumentFile } from "@/lib/validateDocumentFile";

// Semáforo de vigencia (REQ-023/REQ-149): el estado lo recalcula la API en
// cada lectura contra la fecha actual (nunca un valor guardado que pudiera
// quedar obsoleto) — aquí solo se traduce a una etiqueta explícita.
const STATUS_CONFIG: Record<CompanyDocument["status"], { label: string; variant: "success" | "warning" | "destructive" | "outline" }> = {
  valid: { label: "Vigente", variant: "success" },
  expiring_soon: { label: "Por vencer", variant: "warning" },
  expired: { label: "Vencido", variant: "destructive" },
  pending_verification: { label: "Pendiente de verificación", variant: "outline" },
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // dataURL: "data:<mime>;base64,<contenido>" — la API espera solo el
      // contenido en base64 (ver company/schemas.ts: documentCreateSchema).
      const base64 = result.split(",")[1] ?? "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const uploadSchema = z.object({
  documentType: z.string().min(1, "Indica el tipo de documento."),
  validUntil: z.string().optional(),
});
type UploadValues = z.infer<typeof uploadSchema>;

function UploadForm() {
  const uploadDocument = useUploadDocument();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const form = useForm<UploadValues>({ resolver: zodResolver(uploadSchema), defaultValues: { documentType: "", validUntil: "" } });

  const onSubmit = async (values: UploadValues) => {
    if (!selectedFile) {
      toast.error("Selecciona un archivo antes de subir el documento.");
      return;
    }
    // WI-02: revalida en el envío (no solo en la selección) — defensa en
    // profundidad barata por si `selectedFile` llegó aquí por otra vía.
    const validation = validateDocumentFile(selectedFile);
    if (!validation.ok) {
      toast.error(validation.message ?? "Archivo no admitido.");
      return;
    }
    try {
      const contentBase64 = await fileToBase64(selectedFile);
      await uploadDocument.mutateAsync({
        documentType: values.documentType,
        contentBase64,
        validUntil: values.validUntil || undefined,
      });
      toast.success("Documento subido.");
      form.reset();
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-3">
        <FormField
          control={form.control}
          name="documentType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Tipo de documento</FormLabel>
              <FormControl>
                <Input placeholder="p. ej. constancia_situacion_fiscal" {...field} />
              </FormControl>
              <FormMessage />
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
        <div className="flex flex-col gap-1.5">
          <label htmlFor="document-file" className="text-sm font-medium text-foreground">
            Archivo
          </label>
          <input
            id="document-file"
            ref={fileInputRef}
            type="file"
            accept={DOCUMENT_ACCEPT_ATTR}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              if (!file) {
                setSelectedFile(null);
                return;
              }
              // WI-02 (docs/auditoria-2/web-integrado.md / REQ-098): mensaje
              // honesto INMEDIATO (tipo/tamaño) antes de leer el archivo
              // completo a base64 y enviarlo por red — antes de esta
              // corrección, un archivo inválido o de 22MB+ solo se
              // descubría después de que el navegador ya lo hubiera
              // codificado y enviado.
              const validation = validateDocumentFile(file);
              if (!validation.ok) {
                toast.error(validation.message ?? "Archivo no admitido.");
                setSelectedFile(null);
                event.target.value = "";
                return;
              }
              setSelectedFile(file);
            }}
            className="text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
          />
        </div>
        <Button type="submit" className="gap-1.5" disabled={uploadDocument.isPending}>
          <Upload className="h-4 w-4" aria-hidden="true" />
          {uploadDocument.isPending ? "Subiendo…" : "Subir documento"}
        </Button>
      </form>
    </Form>
  );
}

export default function DocumentosVigenciasPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const { data: documents, isLoading, isError, error, refetch } = useDocuments();
  const deleteDocument = useDeleteDocument();
  const canWrite = Boolean(currentMembership && MEMBERSHIP_ADMIN_ROLES.includes(currentMembership.role));

  return (
    <div>
      <SectionHeader
        icon={FileClock}
        title="Documentos y vigencias"
        description="Documentos de la empresa con semáforo de vigencia real (vencido/por vencer/vigente/pendiente de verificación)."
      />
      {!currentOrgId ? (
        <EmptyState icon={FileClock} title="Selecciona una organización" description="Elige una organización en el encabezado para ver sus documentos." />
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle level={2}>Subir documento</CardTitle>
              <CardDescription>
                {canWrite
                  ? "Solo owner/admin pueden subir o eliminar documentos de empresa (más sensibles que el resto del perfil)."
                  : `Tu rol (${currentMembership?.role ?? "sin rol"}) no puede subir documentos — solo owner/admin.`}
              </CardDescription>
            </CardHeader>
            {canWrite && <CardContent><UploadForm /></CardContent>}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle level={2}>Documentos registrados</CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading && <LoadingState label="Cargando documentos…" />}
              {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
              {!isLoading && !isError && (!documents || documents.length === 0) && (
                <EmptyState icon={FileClock} title="Aún no hay documentos" description="Sube el primer documento de la empresa para empezar a controlar su vigencia." />
              )}
              {!isLoading && !isError && documents && documents.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Vigente hasta</TableHead>
                      <TableHead>Estado</TableHead>
                      {canWrite && <TableHead>Acciones</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {documents.map((doc) => {
                      const status = STATUS_CONFIG[doc.status];
                      return (
                        <TableRow key={doc.id}>
                          <TableCell className="font-medium">{doc.documentType}</TableCell>
                          <TableCell>{formatDateMx(doc.validUntil)}</TableCell>
                          <TableCell>
                            <Badge variant={status.variant}>{status.label}</Badge>
                          </TableCell>
                          {canWrite && (
                            <TableCell>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                aria-label={`Eliminar documento ${doc.documentType}`}
                                onClick={() => {
                                  deleteDocument.mutate(doc.id, {
                                    onError: (err) => toast.error(describeApiError(err)),
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
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
