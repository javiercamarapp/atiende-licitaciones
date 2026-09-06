import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { ShieldAlert, ArrowLeft } from "lucide-react";

import { SkipLink } from "@/components/SkipLink";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { describeApiError } from "@/hooks/useAuth";
import { getPrivacyNotice } from "@/lib/api/legal";
import { renderSimpleMarkdown } from "@/lib/renderSimpleMarkdown";
import { formatDateMx } from "@/lib/datetime";

/**
 * Aviso de privacidad (REQ-119/REQ-131, docs/TABLERO.md §6): servido
 * versionado por `GET /legal/privacy-notice` (ruta pública de apps/api,
 * sin autenticación — ver apps/api/src/modules/legal/routes.ts), a partir
 * de `apps/api/docs/legal/privacy-notice.md`. Esta página NUNCA redacta el
 * contenido por su cuenta: solo lo obtiene y renderiza tal cual, incluido
 * el `status` (siempre `"borrador_pendiente_validacion_juridica"` hasta
 * que un abogado mexicano lo confirme).
 */
export default function PrivacyNoticePage() {
  const { data: notice, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["legal", "privacy-notice"],
    queryFn: getPrivacyNotice,
  });

  return (
    <>
      {/* W-09/W-18: página pública standalone (fuera de <AppShell/>, ver
          App.tsx) -- no hereda el skip-link ni el `#main-content` de la
          shell autenticada, así que declara los suyos propios con el mismo
          patrón (foco real vía SkipLink.tsx, indicador de foco visible vía
          `focus-visible:ring-*`, nunca `outline-none` sin reemplazo). */}
      <SkipLink targetId="main-content">Saltar al contenido principal</SkipLink>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-3xl px-4 py-10 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-6"
      >
        <Link to="/panel" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Volver
        </Link>

        <SectionHeader icon={ShieldAlert} title="Aviso de privacidad" description="Tratamiento de datos personales en Atiende Licitaciones." />

        {isLoading && <LoadingState label="Cargando aviso de privacidad…" />}
        {isError && <ErrorState message={describeApiError(error)} onRetry={() => refetch()} />}

        {!isLoading && !isError && notice && (
          <>
            <Card className="mb-6 border-warning/40 bg-warning/5">
              <CardHeader className="flex-row items-start gap-3 space-y-0">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" strokeWidth={1.75} />
                <div>
                  <CardTitle className="text-base">Borrador pendiente de validación jurídica</CardTitle>
                  <CardDescription>
                    Este aviso (versión {notice.version}, publicado {formatDateMx(notice.publishedAt)}) se redactó a
                    partir de una verificación legal documentada ({notice.sourceDocument}), pero NINGÚN abogado
                    mexicano lo ha validado todavía. No debe presentarse como definitivo a un cliente real ni usarse
                    para cumplir una obligación legal sin esa revisión.
                  </CardDescription>
                </div>
              </CardHeader>
            </Card>

            <Card className="mb-6">
              <CardContentMeta label="Responsable" value={notice.responsible} />
              <CardContentMeta label="Autoridad supervisora" value={notice.supervisoryAuthority} />
              <CardContentMeta label="Ley aplicable" value={notice.applicableLaw} />
            </Card>

            {renderSimpleMarkdown(notice.contentMarkdown)}
          </>
        )}
      </main>
    </>
  );
}

function CardContentMeta({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-b border-border px-6 py-3 text-sm last:border-b-0">
      <span className="font-medium text-foreground">{label}: </span>
      <span className="text-muted-foreground">{value}</span>
    </div>
  );
}
