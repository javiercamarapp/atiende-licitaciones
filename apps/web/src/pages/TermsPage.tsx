import { Link } from "react-router-dom";
import { ScrollText, ArrowLeft } from "lucide-react";

import { SkipLink } from "@/components/SkipLink";
import { SectionHeader } from "@/components/layout/SectionHeader";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { renderSimpleMarkdown } from "@/lib/renderSimpleMarkdown";
import { TERMS_CONTENT_MARKDOWN, TERMS_LAST_UPDATED, TERMS_VERSION } from "@/lib/legal/termsContent";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

/**
 * Términos de servicio (REQ §34.4, docs/AMPLIACION-2-SALIDA.md §3-4):
 * pública, sin sesión (mismo criterio que `/privacidad` — debe poder
 * consultarse antes de crear una cuenta). Ver docstring de
 * lib/legal/termsContent.ts para por qué el contenido es una constante
 * local en vez de venir de un endpoint (no existe uno en apps/api).
 */
export default function TermsPage() {
  useDocumentMeta({
    title: "Términos de servicio",
    description: "Términos de servicio de Atiende Licitaciones — borrador pendiente de validación jurídica.",
    robots: "noindex, nofollow",
  });

  return (
    <>
      <SkipLink targetId="main-content">Saltar al contenido principal</SkipLink>
      <main
        id="main-content"
        tabIndex={-1}
        className="mx-auto max-w-3xl px-4 py-10 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:px-6"
      >
        <Link to="/" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Volver al inicio
        </Link>

        <SectionHeader icon={ScrollText} title="Términos de servicio" description="Condiciones de uso de Atiende Licitaciones." />

        <Card className="mb-6 border-warning/40 bg-warning/5">
          <CardHeader className="flex-row items-start gap-3 space-y-0">
            <ScrollText className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" strokeWidth={1.75} />
            <div>
              <CardTitle className="text-base">Borrador pendiente de validación jurídica</CardTitle>
              <CardDescription>
                Versión {TERMS_VERSION}, actualizada {TERMS_LAST_UPDATED}. Los apartados marcados{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">FaltaDato</code> requieren una decisión jurídica
                y/o comercial que todavía no se ha tomado — ningún abogado mexicano ha validado este documento. No debe
                presentarse como definitivo a un cliente real.
              </CardDescription>
            </div>
          </CardHeader>
        </Card>

        {renderSimpleMarkdown(TERMS_CONTENT_MARKDOWN)}
      </main>
    </>
  );
}
