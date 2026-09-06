import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FileSearch, Upload, AlertTriangle, RefreshCw } from "lucide-react";

import { AiDisclosureNote } from "@/components/AiDisclosureNote";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { TenderSelect } from "@/components/expediente/TenderSelect";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import {
  useTenderDocuments,
  useUploadTenderDocument,
  useRequirementMatrix,
  useBuildRequirementMatrix,
  useUpdateRequirementItem,
  useRequirementConflicts,
  useResolveConflict,
} from "@/hooks/useExpediente";
import { WRITE_ROLES, MATRIX_STATUSES, DOCUMENT_KINDS, type DocumentKind, type MatrixStatus } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

const EXTRACTION_LABELS: Record<string, { label: string; variant: "success" | "warning" | "destructive" | "outline" }> = {
  extracted: { label: "Texto extraído", variant: "success" },
  requires_ocr: { label: "Requiere OCR (no disponible en esta ronda)", variant: "warning" },
  pending: { label: "Pendiente de extracción", variant: "outline" },
  failed: { label: "Extracción fallida", variant: "destructive" },
};

const MATRIX_STATUS_LABELS: Record<MatrixStatus, string> = {
  pendiente: "Pendiente",
  en_progreso: "En progreso",
  cumplido: "Cumplido",
  bloqueado: "Bloqueado",
  no_evaluable: "No evaluable",
};

const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  bases: "Bases",
  anexo: "Anexo",
  aclaracion: "Aclaración",
  otro: "Otro",
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const uploadSchema = z.object({ documentKind: z.enum(DOCUMENT_KINDS) });
type UploadValues = z.infer<typeof uploadSchema>;

function DocumentsSection({ tenderId, canWrite }: { tenderId: string; canWrite: boolean }) {
  const { data: documents, isLoading, isError, error, refetch } = useTenderDocuments(tenderId);
  const upload = useUploadTenderDocument(tenderId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const form = useForm<UploadValues>({ resolver: zodResolver(uploadSchema), defaultValues: { documentKind: "bases" } });

  const onSubmit = async (values: UploadValues) => {
    if (!selectedFile) {
      toast.error("Selecciona un archivo antes de subir el documento.");
      return;
    }
    try {
      const contentBase64 = await fileToBase64(selectedFile);
      await upload.mutateAsync({ documentKind: values.documentKind, filename: selectedFile.name, mimeType: selectedFile.type || undefined, contentBase64 });
      toast.success("Documento subido. Si ya existía un documento de bases, esta subida se registra como nueva versión.");
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <div className="space-y-6">
      {canWrite && (
        <Card>
          <CardHeader>
            <CardTitle level={2} className="text-base">
              Subir documento
            </CardTitle>
            <CardDescription>
              Subir un nuevo documento de "bases" cuando ya existe uno anterior lo registra como nueva versión (historial
              conservado, nunca borrado).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-wrap items-end gap-3">
                <FormField
                  control={form.control}
                  name="documentKind"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Tipo</FormLabel>
                      <FormControl>
                        <Select value={field.value} onValueChange={field.onChange}>
                          <SelectTrigger aria-label="Tipo de documento" className="w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {DOCUMENT_KINDS.map((k) => (
                              <SelectItem key={k} value={k}>
                                {DOCUMENT_KIND_LABELS[k]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="bases-file" className="text-sm font-medium text-foreground">
                    Archivo (PDF de preferencia)
                  </label>
                  <input
                    id="bases-file"
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.txt,application/pdf,text/plain"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                    className="text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-primary-foreground"
                  />
                </div>
                <Button type="submit" className="gap-1.5" disabled={upload.isPending}>
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  {upload.isPending ? "Subiendo…" : "Subir"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      )}

      {isLoading && <LoadingState label="Cargando documentos…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && (!documents || documents.length === 0) && (
        <EmptyState icon={FileSearch} title="Aún no hay documentos" description="Sube el documento de bases de esta convocatoria para empezar a extraer su matriz de requisitos." />
      )}
      {!isLoading && !isError && documents && documents.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Archivo</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Extracción de texto</TableHead>
                  <TableHead>Páginas</TableHead>
                  <TableHead>Subido (CDMX)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {documents.map((doc) => {
                  const extraction = EXTRACTION_LABELS[doc.textExtractionStatus] ?? EXTRACTION_LABELS.pending;
                  return (
                    <TableRow key={doc.id}>
                      <TableCell className="font-medium">{doc.originalFilename ?? doc.id}</TableCell>
                      <TableCell>{DOCUMENT_KIND_LABELS[doc.documentKind as DocumentKind] ?? doc.documentKind}</TableCell>
                      <TableCell>
                        <Badge variant={extraction.variant}>{extraction.label}</Badge>
                      </TableCell>
                      <TableCell>{doc.pageCount ?? "—"}</TableCell>
                      <TableCell>{formatDateTimeMx(doc.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function MatrixSection({ tenderId, canWrite }: { tenderId: string; canWrite: boolean }) {
  const { data: matrix, isLoading, isError, error, refetch } = useRequirementMatrix(tenderId);
  const build = useBuildRequirementMatrix(tenderId);
  const update = useUpdateRequirementItem(tenderId);

  const onBuild = async () => {
    try {
      const result = await build.mutateAsync();
      toast.success(
        `Matriz recalculada: ${result.itemsCreated} requisitos nuevos, ${result.conflictsCreated} conflictos, ${result.documentsUsed} documentos usados (${result.documentsSkipped.length} omitidos).`,
      );
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <div className="space-y-4">
      {canWrite && (
        <Button type="button" variant="outline" className="gap-1.5" onClick={onBuild} disabled={build.isPending}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          {build.isPending ? "Recalculando…" : "Recalcular matriz de requisitos"}
        </Button>
      )}
      {isLoading && <LoadingState label="Cargando matriz…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && (!matrix || matrix.length === 0) && (
        <EmptyState
          icon={FileSearch}
          title="Sin requisitos extraídos todavía"
          description="Sube un documento de bases con texto extraído (no requires_ocr) y recalcula la matriz para ver los requisitos aquí."
        />
      )}
      {!isLoading && !isError && matrix && matrix.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Descripción</TableHead>
                  <TableHead>Fuente</TableHead>
                  <TableHead>Obligatoriedad</TableHead>
                  <TableHead>Responsable</TableHead>
                  <TableHead>Plazo</TableHead>
                  <TableHead>Estado</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matrix.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="max-w-xs">
                      <p className="line-clamp-2">{item.description}</p>
                      {item.invalidatedAt && (
                        <Badge variant="outline" className="mt-1">
                          Invalidado ({item.invalidatedReason ?? "cambio de bases"})
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {item.clauseRef ?? "sin cláusula"}
                      {item.sourcePage != null ? ` · pág. ${item.sourcePage}` : ""}
                    </TableCell>
                    <TableCell>
                      <Badge variant={item.obligatoriedad === "obligatorio" ? "destructive" : item.obligatoriedad === "condicional" ? "warning" : "outline"}>
                        {item.obligatoriedad}
                      </Badge>
                    </TableCell>
                    <TableCell>{item.responsibleRole ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">{item.deadlineAt ? formatDateTimeMx(item.deadlineAt) : "—"}</TableCell>
                    <TableCell>
                      {canWrite ? (
                        <Select
                          value={item.matrixStatus}
                          onValueChange={(value) => {
                            update.mutate(
                              { id: item.id, input: { matrixStatus: value as MatrixStatus } },
                              { onError: (err) => toast.error(describeApiError(err)) },
                            );
                          }}
                        >
                          <SelectTrigger aria-label={`Estado de "${item.description}"`} className="w-[160px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MATRIX_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>
                                {MATRIX_STATUS_LABELS[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Badge variant="outline">{MATRIX_STATUS_LABELS[item.matrixStatus]}</Badge>
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
  );
}

function ConflictsSection({ tenderId, canWrite }: { tenderId: string; canWrite: boolean }) {
  const { data: conflicts, isLoading, isError, error, refetch } = useRequirementConflicts(tenderId);
  const resolve = useResolveConflict(tenderId);
  const [notesById, setNotesById] = useState<Record<string, string>>({});

  return (
    <div className="space-y-4">
      {isLoading && <LoadingState label="Cargando conflictos…" />}
      {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
      {!isLoading && !isError && (!conflicts || conflicts.length === 0) && (
        <EmptyState icon={AlertTriangle} title="Sin conflictos" description="No se detectaron plazos u obligatoriedad contradictorios entre documentos de esta convocatoria." />
      )}
      {!isLoading && !isError && conflicts && conflicts.length > 0 && (
        <ul className="space-y-3">
          {conflicts.map((c) => (
            <li key={c.id}>
              <Card className={c.status === "resuelto" ? "" : "border-warning/40 bg-warning/5"}>
                <CardContent className="space-y-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Badge variant={c.status === "resuelto" ? "success" : "warning"}>{c.status === "resuelto" ? "Resuelto" : "Escalado"}</Badge>
                      <p className="mt-1.5 text-sm text-foreground">{c.description}</p>
                      <p className="text-xs text-muted-foreground">Tema: {c.topicKey} · tipo: {c.kind}</p>
                    </div>
                  </div>
                  {c.status === "resuelto" ? (
                    <p className="text-xs text-muted-foreground">Resuelto {formatDateTimeMx(c.resolvedAt)}: {c.resolutionNotes}</p>
                  ) : (
                    canWrite && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          aria-label={`Notas de resolución para el conflicto "${c.description}"`}
                          placeholder="Notas de resolución"
                          value={notesById[c.id] ?? ""}
                          onChange={(e) => setNotesById((prev) => ({ ...prev, [c.id]: e.target.value }))}
                          className="max-w-sm"
                        />
                        <Button
                          type="button"
                          size="sm"
                          disabled={resolve.isPending || !(notesById[c.id] ?? "").trim()}
                          onClick={() => {
                            resolve.mutate(
                              { id: c.id, resolutionNotes: (notesById[c.id] ?? "").trim() },
                              { onSuccess: () => toast.success("Conflicto resuelto."), onError: (err) => toast.error(describeApiError(err)) },
                            );
                          }}
                        >
                          Marcar como resuelto
                        </Button>
                      </div>
                    )
                  )}
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function AnalisisBasesPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const [tenderId, setTenderId] = useState<string | null>(null);
  const canWrite = Boolean(currentMembership && WRITE_ROLES.includes(currentMembership.role));

  return (
    <div>
      <SectionHeader
        icon={FileSearch}
        title="Análisis de bases"
        description="Documentos de bases, extracción de texto, matriz de requisitos y conflictos escalados, por convocatoria."
      />
      <AiDisclosureNote />

      {!currentOrgId ? (
        <EmptyState icon={FileSearch} title="Selecciona una organización" description="Elige una organización en el encabezado para analizar sus convocatorias." />
      ) : (
        <div className="space-y-6">
          <TenderSelect value={tenderId} onChange={setTenderId} />

          {tenderId && (
            <>
              <Card className="border-dashed">
                <CardContent className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm text-muted-foreground">
                  <span>Historial de versiones y aclaraciones de esta convocatoria.</span>
                  <Link to={`/convocatorias/descubrimiento/${tenderId}`} className="font-medium text-primary hover:underline">
                    Ver versiones y eventos →
                  </Link>
                </CardContent>
              </Card>

              <Tabs defaultValue="documentos">
                <TabsList>
                  <TabsTrigger value="documentos">Documentos</TabsTrigger>
                  <TabsTrigger value="matriz">Matriz de requisitos</TabsTrigger>
                  <TabsTrigger value="conflictos">Conflictos</TabsTrigger>
                </TabsList>
                <TabsContent value="documentos">
                  <DocumentsSection tenderId={tenderId} canWrite={canWrite} />
                </TabsContent>
                <TabsContent value="matriz">
                  <MatrixSection tenderId={tenderId} canWrite={canWrite} />
                </TabsContent>
                <TabsContent value="conflictos">
                  <ConflictsSection tenderId={tenderId} canWrite={canWrite} />
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      )}
    </div>
  );
}
