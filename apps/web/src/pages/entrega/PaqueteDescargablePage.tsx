import { useState } from "react";
import { PackageCheck, ShieldAlert, Download, Boxes } from "lucide-react";

import { SectionHeader } from "@/components/layout/SectionHeader";
import { TenderSelect } from "@/components/expediente/TenderSelect";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PackageStatusBadge, type PaqueteEstado } from "@/components/ui/package-status-badge";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useLatestPackage, useAssemblePackage } from "@/hooks/useExpediente";
import { downloadPackage } from "@/lib/api/expediente";
import { getTokens } from "@/lib/api/session";
import { WRITE_ROLES } from "@/lib/api/schemas";
import { formatDateTimeMx } from "@/lib/datetime";

/**
 * `status` viene SIEMPRE derivado por el propio servidor
 * (`PackageAssembler`/`deriveCurrentManifest`, ver apps/api/README.md, A13/
 * A14): esta pantalla NUNCA decide "listo" por su cuenta, solo traduce
 * `"draft"|"ready"` al vocabulario en español de `PackageStatusBadge`.
 */
function toEstado(status: "draft" | "ready"): PaqueteEstado {
  return status === "ready" ? "listo" : "borrador";
}

export default function PaqueteDescargablePage() {
  const { currentOrgId, currentMembership } = useAuth();
  const [tenderId, setTenderId] = useState<string | null>(null);
  const canWrite = Boolean(currentMembership && WRITE_ROLES.includes(currentMembership.role));
  const { data: pkg, isLoading, isError, error, refetch } = useLatestPackage(tenderId);
  const assemble = useAssemblePackage(tenderId);
  const [downloading, setDownloading] = useState(false);

  const onAssemble = async () => {
    try {
      const result = await assemble.mutateAsync();
      toast.success(result.status === "ready" ? "Paquete ensamblado: listo para presentar." : `Paquete ensamblado como borrador: ${result.draftReasons.join("; ") || "faltan validaciones"}.`);
    } catch (err) {
      toast.error(describeApiError(err));
    }
  };

  const onDownload = async () => {
    if (!currentOrgId || !tenderId) return;
    const { accessToken } = getTokens();
    if (!accessToken) {
      toast.error("Sesión no válida. Inicia sesión de nuevo.");
      return;
    }
    setDownloading(true);
    try {
      const blob = await downloadPackage(currentOrgId, tenderId, accessToken);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `expediente-${tenderId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      <SectionHeader
        icon={PackageCheck}
        title="Paquete descargable"
        description="Ensamblado del expediente completo, manifiesto con hashes, estado Borrador/Listo derivado por el servidor y descarga autenticada."
      />

      <Card className="mb-6 border-warning/40 bg-warning/5">
        <CardHeader className="flex-row items-start gap-3 space-y-0">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" strokeWidth={1.75} />
          <div>
            <CardTitle className="text-base">La presentación y firma las realiza el usuario</CardTitle>
            <CardDescription>
              Esta plataforma no presenta ofertas ni firma documentos en tu nombre, ni actúa en portales oficiales o
              contacta terceros por su cuenta. Tú revisas y presentas el expediente.
            </CardDescription>
          </div>
        </CardHeader>
      </Card>

      {!currentOrgId ? (
        <EmptyState icon={PackageCheck} title="Selecciona una organización" description="Elige una organización en el encabezado para ver su paquete de entrega." />
      ) : (
        <div className="space-y-6">
          <TenderSelect value={tenderId} onChange={setTenderId} />

          {tenderId && (
            <>
              {canWrite && (
                <Button type="button" variant="outline" className="gap-1.5" disabled={assemble.isPending} onClick={onAssemble}>
                  <Boxes className="h-4 w-4" aria-hidden="true" />
                  {assemble.isPending ? "Ensamblando…" : "Ensamblar paquete"}
                </Button>
              )}

              {isLoading && <LoadingState label="Cargando paquete…" />}
              {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}
              {!isLoading && !isError && !pkg && (
                <EmptyState
                  icon={PackageCheck}
                  title="Aún no hay paquete generado"
                  description="Ensambla el paquete para ver aquí su manifiesto. Mientras falten datos, firmas o anexos, se exporta como borrador — nunca como listo."
                />
              )}
              {!isLoading && !isError && pkg && (
                <Card>
                  <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div>
                      <CardTitle level={2} className="text-base">
                        Manifiesto del paquete
                      </CardTitle>
                      <CardDescription>Generado {formatDateTimeMx(pkg.generatedAt)}</CardDescription>
                    </div>
                    <PackageStatusBadge estado={toEstado(pkg.status)} />
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">{pkg.notice}</p>
                    {pkg.missing.length > 0 && (
                      <div>
                        <p className="text-sm font-medium text-foreground">Faltantes</p>
                        <ul className="list-inside list-disc text-sm text-muted-foreground">
                          {pkg.missing.map((m, i) => (
                            <li key={i}>{m}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {pkg.draftReasons.length > 0 && (
                      <div>
                        <p className="text-sm font-medium text-foreground">Motivos de borrador</p>
                        <ul className="list-inside list-disc text-sm text-muted-foreground">
                          {pkg.draftReasons.map((m, i) => (
                            <li key={i}>{m}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <Button type="button" className="gap-1.5" disabled={downloading} onClick={onDownload}>
                      <Download className="h-4 w-4" aria-hidden="true" />
                      {downloading ? "Descargando…" : "Descargar paquete (.zip)"}
                    </Button>
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
