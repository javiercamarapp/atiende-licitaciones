import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FlaskConical, Radar, Target, Timer, ArrowLeft, LogIn } from "lucide-react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { SkipLink } from "@/components/SkipLink";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { KpiCard } from "@/components/dashboard/KpiCard";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { AlertsList } from "@/components/dashboard/AlertsList";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";
import type { AuditLogEntry, Followup, MatchResult, MyOrg, Tender } from "@/lib/api/schemas";

interface DemoState {
  status: "starting" | "ready" | "unsupported" | "error";
  errorMessage?: string;
  org?: MyOrg;
  tenders: Tender[];
  matches: MatchResult[];
  alerts: Followup[];
  auditLog: AuditLogEntry[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

async function fetchDemoData() {
  const [org, tendersRes, matchesRes, alerts, auditRes] = await Promise.all([
    fetch("/demo-api/organization").then((r) => r.json() as Promise<MyOrg>),
    fetch("/demo-api/tenders").then((r) => r.json() as Promise<{ items: Tender[] }>),
    fetch("/demo-api/matching").then((r) => r.json() as Promise<{ items: MatchResult[] }>),
    fetch("/demo-api/post-award-alerts").then((r) => r.json() as Promise<Followup[]>),
    fetch("/demo-api/audit-log").then((r) => r.json() as Promise<{ items: AuditLogEntry[] }>),
  ]);
  return { org, tenders: tendersRes.items, matches: matchesRes.items, alerts, auditLog: auditRes.items };
}

/**
 * Demo pública de solo lectura (ronda 7, REQ §34.4): muestra el flujo del
 * panel sin necesidad de cuenta, con una organización de ejemplo
 * CLARAMENTE etiquetada. Los datos vienen de MSW (`mocks/browser.ts`),
 * cargado con `import()` dinámico y arrancado SOLO mientras este componente
 * está montado -- nunca se importa desde `main.tsx` ni se mezcla con el
 * cliente real (`lib/api/client.ts`), así que ninguna otra pantalla de la
 * aplicación puede verse afectada por este mock.
 *
 * Si el navegador no soporta Service Workers (o la política del entorno los
 * bloquea), se muestra un estado honesto en vez de fingir datos --
 * `msw/browser` no funciona sin uno.
 */
export default function DemoPage() {
  const [state, setState] = useState<DemoState>({ status: "starting", tenders: [], matches: [], alerts: [], auditLog: [] });

  useDocumentMeta({
    title: "Demo",
    description: "Recorre el flujo de Atiende Licitaciones con datos de ejemplo, sin necesidad de crear una cuenta.",
    robots: "index, follow",
  });

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      setState((s) => ({ ...s, status: "unsupported" }));
      return;
    }

    let stopped = false;
    let workerRef: { stop: () => void } | null = null;

    async function start() {
      try {
        const { demoWorker } = await import("@/mocks/browser");
        await demoWorker.start({ onUnhandledRequest: "bypass", serviceWorker: { url: "/mockServiceWorker.js" }, quiet: true });
        if (stopped) {
          demoWorker.stop();
          return;
        }
        workerRef = demoWorker;
        const data = await fetchDemoData();
        if (!stopped) setState({ status: "ready", ...data });
      } catch (err) {
        if (!stopped) setState((s) => ({ ...s, status: "error", errorMessage: err instanceof Error ? err.message : "No se pudo iniciar la demo." }));
      }
    }
    void start();

    return () => {
      stopped = true;
      workerRef?.stop();
    };
  }, []);

  const now = Date.now();
  const newTenders7d = state.tenders.filter((t) => now - new Date(t.createdAt).getTime() <= 7 * MS_PER_DAY).length;
  const matchesEligible = state.matches.filter((m) => m.eligibility.status === "cumple").length;
  const upcoming = state.alerts.filter((a) => a.alertLevel === "proximo").length;
  const overdue = state.alerts.filter((a) => a.alertLevel === "vencido").length;

  return (
    <>
      <SkipLink targetId="main-content">Saltar al contenido principal</SkipLink>
      <div className="min-h-screen bg-background">
        <header className="border-b border-border bg-card">
          <div className="container flex h-16 items-center justify-between">
            <AtiendeWordmark />
            <div className="flex items-center gap-2">
              <Button asChild variant="ghost" size="sm" className="gap-1.5">
                <Link to="/">
                  <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                  Volver al inicio
                </Link>
              </Button>
              <Button asChild size="sm" className="gap-1.5">
                <Link to="/login">
                  <LogIn className="h-4 w-4" aria-hidden="true" />
                  Iniciar sesión
                </Link>
              </Button>
            </div>
          </div>
        </header>

        <div role="status" className="border-b border-warning/40 bg-warning/10 px-4 py-3 text-center text-sm font-medium text-warning-foreground">
          <FlaskConical className="mr-1.5 inline-block h-4 w-4 align-text-bottom" aria-hidden="true" />
          Datos de ejemplo — esta organización ({state.org?.name ?? "Constructora Ejemplo S.A. de C.V."}) es ficticia y de solo lectura.
        </div>

        <main id="main-content" tabIndex={-1} className="container max-w-5xl py-8 focus-visible:outline-none">
          {state.status === "starting" && <LoadingState label="Cargando datos de ejemplo…" rows={4} />}

          {state.status === "unsupported" && (
            <ErrorState
              title="Tu navegador no soporta esta demo"
              message="La demo interactiva necesita Service Workers, no disponibles en este navegador o bloqueados por su configuración. Puedes crear una cuenta y explorar la aplicación real, o escribirnos a hola@atiende.mx."
            />
          )}

          {state.status === "error" && (
            <ErrorState message={state.errorMessage ?? "No se pudo cargar la demo."} onRetry={() => window.location.reload()} />
          )}

          {state.status === "ready" && (
            <>
              <h1 className="font-display text-2xl font-semibold text-foreground">Panel de ejemplo</h1>
              <p className="mt-1 text-sm text-muted-foreground">Mismo panel que verías con una cuenta real, con datos de ejemplo.</p>

              <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard icon={Radar} label="Convocatorias nuevas (7 días)" value={newTenders7d} />
                <KpiCard icon={Target} label="Matches elegibles" value={`${matchesEligible} / ${state.matches.length}`} />
                <KpiCard icon={Timer} label="Vencimientos próximos" value={upcoming} tone={upcoming > 0 ? "warning" : "default"} />
                <KpiCard icon={Timer} label="Vencimientos vencidos" value={overdue} tone={overdue > 0 ? "destructive" : "default"} />
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                <AlertsList items={state.alerts} />
                <ActivityFeed items={state.auditLog} />
              </div>
            </>
          )}
        </main>
      </div>
    </>
  );
}
