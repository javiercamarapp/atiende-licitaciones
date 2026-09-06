import { useState } from "react";
import { FolderCheck, Plus, Trash2, PlayCircle } from "lucide-react";

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
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useChecklist, useRunChecklist } from "@/hooks/useExpediente";
import { WRITE_ROLES, type ComplianceResult } from "@/lib/api/schemas";

const RESULT_CONFIG: Record<ComplianceResult, { label: string; variant: "success" | "warning" | "destructive" }> = {
  verde: { label: "Verde", variant: "success" },
  ambar: { label: "Ámbar", variant: "warning" },
  rojo: { label: "Rojo", variant: "destructive" },
};

interface FileRow {
  filename: string;
  extension: string;
  sizeBytes: string;
}

interface SignatureRow {
  role: string;
  userConfirmedSigned: boolean;
}

/**
 * `POST .../checklist/run` (7 dimensiones de `IntegrityChecklist` real)
 * necesita que el llamador declare explícitamente los archivos/firmas/
 * anexos presentes -- este proyecto no modela un "casillero de portal"
 * propio (ver docstring de apps/api/src/modules/expediente/checklist.routes.ts):
 * es una decisión de alcance documentada, no una carencia de esta pantalla.
 * Documentos de empresa (con vigencia real) y el resultado económico se
 * derivan de datos reales por el propio servidor, no se declaran aquí.
 */
function ChecklistRunForm({ tenderId }: { tenderId: string }) {
  const run = useRunChecklist(tenderId);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [signatures, setSignatures] = useState<SignatureRow[]>([]);
  const [annexRefs, setAnnexRefs] = useState<string>("");

  const onRun = async () => {
    try {
      await run.mutateAsync({
        files: files
          .filter((f) => f.filename.trim())
          .map((f) => ({ filename: f.filename.trim(), extension: f.extension.trim() || "pdf", sizeBytes: Number(f.sizeBytes) || 0 })),
        requiredSignatures: signatures.filter((s) => s.role.trim()),
        presentAnnexRefs: annexRefs
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      toast.success("Checklist de integridad ejecutado.");
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Ejecutar checklist de integridad</CardTitle>
        <CardDescription>
          Declara los archivos finales, firmas requeridas y anexos ya adjuntos al expediente. Los documentos de
          empresa y el resultado económico se validan con datos reales, sin declaración manual.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="mb-2 text-sm font-medium text-foreground">Archivos finales (nombre, extensión, tamaño en bytes)</p>
          <div className="space-y-2">
            {files.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Nombre de archivo"
                  placeholder="propuesta-tecnica.pdf"
                  value={f.filename}
                  onChange={(e) => setFiles((prev) => prev.map((row, idx) => (idx === i ? { ...row, filename: e.target.value } : row)))}
                  className="max-w-xs"
                />
                <Input
                  aria-label="Extensión"
                  placeholder="pdf"
                  value={f.extension}
                  onChange={(e) => setFiles((prev) => prev.map((row, idx) => (idx === i ? { ...row, extension: e.target.value } : row)))}
                  className="w-24"
                />
                <Input
                  aria-label="Tamaño en bytes"
                  type="number"
                  placeholder="1048576"
                  value={f.sizeBytes}
                  onChange={(e) => setFiles((prev) => prev.map((row, idx) => (idx === i ? { ...row, sizeBytes: e.target.value } : row)))}
                  className="w-40"
                />
                <Button type="button" variant="ghost" size="icon" aria-label="Quitar archivo" onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => setFiles((prev) => [...prev, { filename: "", extension: "pdf", sizeBytes: "" }])}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Agregar archivo
            </Button>
          </div>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium text-foreground">Firmas requeridas</p>
          <div className="space-y-2">
            {signatures.map((s, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Rol firmante"
                  placeholder="representante_legal"
                  value={s.role}
                  onChange={(e) => setSignatures((prev) => prev.map((row, idx) => (idx === i ? { ...row, role: e.target.value } : row)))}
                  className="max-w-xs"
                />
                <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={s.userConfirmedSigned}
                    onChange={(e) => setSignatures((prev) => prev.map((row, idx) => (idx === i ? { ...row, userConfirmedSigned: e.target.checked } : row)))}
                  />
                  Confirmado como firmado por el usuario
                </label>
                <Button type="button" variant="ghost" size="icon" aria-label="Quitar firma" onClick={() => setSignatures((prev) => prev.filter((_, idx) => idx !== i))}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setSignatures((prev) => [...prev, { role: "", userConfirmedSigned: false }])}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
              Agregar firma
            </Button>
          </div>
        </div>

        <div>
          <label htmlFor="annex-refs" className="mb-2 block text-sm font-medium text-foreground">
            Anexos ya adjuntos (separados por coma; por topicKey o requirementId)
          </label>
          <Input id="annex-refs" placeholder="anexo_1, anexo_carta_compromiso" value={annexRefs} onChange={(e) => setAnnexRefs(e.target.value)} />
        </div>

        <Button type="button" className="gap-1.5" onClick={onRun} disabled={run.isPending}>
          <PlayCircle className="h-4 w-4" aria-hidden="true" />
          {run.isPending ? "Ejecutando…" : "Ejecutar checklist"}
        </Button>
      </CardContent>
    </Card>
  );
}

export default function CumplimientoDocumentalPage() {
  const { currentOrgId, currentMembership } = useAuth();
  const [tenderId, setTenderId] = useState<string | null>(null);
  const canWrite = Boolean(currentMembership && WRITE_ROLES.includes(currentMembership.role));
  const { data: checklist, isLoading, isError, error, refetch } = useChecklist(tenderId);

  return (
    <div>
      <SectionHeader
        icon={FolderCheck}
        title="Cumplimiento documental"
        description="Checklist real de integridad (7 dimensiones), con evidencia, faltantes/bloqueos y vigencias reales de la empresa."
      />

      {!currentOrgId ? (
        <EmptyState icon={FolderCheck} title="Selecciona una organización" description="Elige una organización en el encabezado para ver su cumplimiento documental." />
      ) : (
        <div className="space-y-6">
          <TenderSelect value={tenderId} onChange={setTenderId} />

          {tenderId && (
            <>
              {canWrite && <ChecklistRunForm tenderId={tenderId} />}

              {isLoading && <LoadingState label="Cargando checklist…" />}
              {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
              {!isLoading && !isError && (!checklist || checklist.items.length === 0) && (
                <EmptyState icon={FolderCheck} title="Aún no se ha ejecutado el checklist" description="Ejecuta el checklist de integridad para ver aquí su resultado por dimensión." />
              )}
              {!isLoading && !isError && checklist && checklist.items.length > 0 && (
                <Card>
                  <CardHeader className="flex-row items-center justify-between space-y-0">
                    <CardTitle level={2} className="text-base">
                      Resultado por dimensión
                    </CardTitle>
                    <Badge variant={RESULT_CONFIG[checklist.overallStatus].variant}>General: {RESULT_CONFIG[checklist.overallStatus].label}</Badge>
                  </CardHeader>
                  <CardContent className="p-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Dimensión</TableHead>
                          <TableHead>Resultado</TableHead>
                          <TableHead>Detalle</TableHead>
                          <TableHead>Evidencia</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {checklist.items.map((item) => (
                          <TableRow key={item.id}>
                            <TableCell className="font-medium">{item.dimension ?? item.label}</TableCell>
                            <TableCell>{item.result && <Badge variant={RESULT_CONFIG[item.result].variant}>{RESULT_CONFIG[item.result].label}</Badge>}</TableCell>
                            <TableCell className="max-w-md">{item.notes ?? "—"}</TableCell>
                            <TableCell className="max-w-xs text-xs text-muted-foreground">{item.evidenceRef ?? "Sin evidencia declarada"}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
