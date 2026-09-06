import { Component, Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Navigate, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AtiendeMark } from "@/components/AtiendeLogo";
import { AppShell } from "@/components/layout/AppShell";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";

const LoginPage = lazy(() => import("@/pages/LoginPage"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage"));
const PanelPage = lazy(() => import("@/pages/PanelPage"));
const PerfilCapacidadesPage = lazy(() => import("@/pages/empresa/PerfilCapacidadesPage"));
const DocumentosVigenciasPage = lazy(() => import("@/pages/empresa/DocumentosVigenciasPage"));
const FirmantesAutorizadosPage = lazy(() => import("@/pages/empresa/FirmantesAutorizadosPage"));
const TarifasAprobadasPage = lazy(() => import("@/pages/empresa/TarifasAprobadasPage"));
const DescubrimientoPage = lazy(() => import("@/pages/convocatorias/DescubrimientoPage"));
const MatchingPage = lazy(() => import("@/pages/convocatorias/MatchingPage"));
const FuentesFrescuraPage = lazy(() => import("@/pages/convocatorias/FuentesFrescuraPage"));
const GoNoGoPage = lazy(() => import("@/pages/evaluacion/GoNoGoPage"));
const AnalisisBasesPage = lazy(() => import("@/pages/evaluacion/AnalisisBasesPage"));
const CumplimientoDocumentalPage = lazy(() => import("@/pages/preparacion/CumplimientoDocumentalPage"));
const RedaccionPage = lazy(() => import("@/pages/preparacion/RedaccionPage"));
const RevisionPage = lazy(() => import("@/pages/preparacion/RevisionPage"));
const ExpedientePage = lazy(() => import("@/pages/preparacion/ExpedientePage"));
const AprobacionesPage = lazy(() => import("@/pages/preparacion/AprobacionesPage"));
const EntregasPage = lazy(() => import("@/pages/entrega/EntregasPage"));
const PaqueteDescargablePage = lazy(() => import("@/pages/entrega/PaqueteDescargablePage"));
const SeguimientoPage = lazy(() => import("@/pages/entrega/SeguimientoPage"));
const OrganizacionesPage = lazy(() => import("@/pages/backoffice/OrganizacionesPage"));
const UsuariosRolesPage = lazy(() => import("@/pages/backoffice/UsuariosRolesPage"));
const AgentesHerramientasPage = lazy(() => import("@/pages/backoffice/AgentesHerramientasPage"));
const AuditoriaPage = lazy(() => import("@/pages/backoffice/AuditoriaPage"));
const ConfiguracionPage = lazy(() => import("@/pages/ConfiguracionPage"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function LoadingScreen() {
  return (
    <div role="status" aria-label="Cargando" className="flex min-h-screen items-center justify-center bg-background">
      <AtiendeMark className="atiende-respira h-10 w-auto" animado />
    </div>
  );
}

interface RouteErrorBoundaryState {
  hasError: boolean;
}

/**
 * Atrapa fallos de import dinámico de rutas (chunk perdido tras un
 * deploy nuevo, red intermitente) y ofrece recargar en vez de dejar la
 * pantalla en blanco.
 */
class RouteErrorBoundary extends Component<{ children: ReactNode }, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
          <p className="font-display text-lg font-semibold text-foreground">No se pudo cargar esta página</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Puede deberse a una actualización reciente de la aplicación. Recarga para intentarlo de nuevo.
          </p>
          <Button type="button" onClick={() => window.location.reload()}>
            Recargar
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <BrowserRouter basename={import.meta.env.BASE_URL}>
          <RouteErrorBoundary>
            <Suspense fallback={<LoadingScreen />}>
              <Routes>
                <Route path="/" element={<Navigate to="/panel" replace />} />
                <Route path="/login" element={<LoginPage />} />
                <Route element={<AppShell />}>
                  <Route path="/panel" element={<PanelPage />} />
                  <Route path="/empresa/perfil-capacidades" element={<PerfilCapacidadesPage />} />
                  <Route path="/empresa/documentos-vigencias" element={<DocumentosVigenciasPage />} />
                  <Route path="/empresa/firmantes-autorizados" element={<FirmantesAutorizadosPage />} />
                  <Route path="/empresa/tarifas-aprobadas" element={<TarifasAprobadasPage />} />
                  <Route path="/convocatorias/descubrimiento" element={<DescubrimientoPage />} />
                  <Route path="/convocatorias/matching" element={<MatchingPage />} />
                  <Route path="/convocatorias/fuentes-frescura" element={<FuentesFrescuraPage />} />
                  <Route path="/evaluacion/go-no-go" element={<GoNoGoPage />} />
                  <Route path="/evaluacion/analisis-bases" element={<AnalisisBasesPage />} />
                  <Route path="/preparacion/cumplimiento-documental" element={<CumplimientoDocumentalPage />} />
                  <Route path="/preparacion/redaccion" element={<RedaccionPage />} />
                  <Route path="/preparacion/revision" element={<RevisionPage />} />
                  <Route path="/preparacion/expediente" element={<ExpedientePage />} />
                  <Route path="/preparacion/aprobaciones" element={<AprobacionesPage />} />
                  <Route path="/entrega/entregas" element={<EntregasPage />} />
                  <Route path="/entrega/paquete-descargable" element={<PaqueteDescargablePage />} />
                  <Route path="/entrega/seguimiento" element={<SeguimientoPage />} />
                  <Route path="/backoffice/organizaciones" element={<OrganizacionesPage />} />
                  <Route path="/backoffice/usuarios-roles" element={<UsuariosRolesPage />} />
                  <Route path="/backoffice/agentes-herramientas" element={<AgentesHerramientasPage />} />
                  <Route path="/backoffice/auditoria" element={<AuditoriaPage />} />
                  <Route path="/configuracion" element={<ConfiguracionPage />} />
                </Route>
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Suspense>
          </RouteErrorBoundary>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
