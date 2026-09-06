import { Component, Suspense, lazy, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";

import { AtiendeMark } from "@/components/AtiendeLogo";
import { AppShell } from "@/components/layout/AppShell";
import { RequireAuth, RequireOrganization } from "@/components/auth/RequireAuth";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { AuthProvider } from "@/hooks/useAuth";
import { queryClient } from "@/lib/queryClient";

const LandingPage = lazy(() => import("@/pages/LandingPage"));
const LoginPage = lazy(() => import("@/pages/LoginPage"));
const RegistroPage = lazy(() => import("@/pages/RegistroPage"));
const GoogleCallbackPage = lazy(() => import("@/pages/auth/GoogleCallbackPage"));
const PrivacyNoticePage = lazy(() => import("@/pages/PrivacyNoticePage"));
const TermsPage = lazy(() => import("@/pages/TermsPage"));
const DemoPage = lazy(() => import("@/pages/DemoPage"));
const OnboardingPage = lazy(() => import("@/pages/onboarding/OnboardingPage"));
const SinAccesoPage = lazy(() => import("@/pages/SinAccesoPage"));
const NotFoundPage = lazy(() => import("@/pages/NotFoundPage"));
const PanelPage = lazy(() => import("@/pages/PanelPage"));
const PerfilCapacidadesPage = lazy(() => import("@/pages/empresa/PerfilCapacidadesPage"));
const DocumentosVigenciasPage = lazy(() => import("@/pages/empresa/DocumentosVigenciasPage"));
const FirmantesAutorizadosPage = lazy(() => import("@/pages/empresa/FirmantesAutorizadosPage"));
const TarifasAprobadasPage = lazy(() => import("@/pages/empresa/TarifasAprobadasPage"));
const DescubrimientoPage = lazy(() => import("@/pages/convocatorias/DescubrimientoPage"));
const ConvocatoriaDetallePage = lazy(() => import("@/pages/convocatorias/ConvocatoriaDetallePage"));
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
const ConectoresPage = lazy(() => import("@/pages/backoffice/ConectoresPage"));
const JobsPage = lazy(() => import("@/pages/backoffice/JobsPage"));
const CostosPage = lazy(() => import("@/pages/backoffice/CostosPage"));
const IncidentesPage = lazy(() => import("@/pages/backoffice/IncidentesPage"));
const AprobacionesBackofficePage = lazy(() => import("@/pages/backoffice/AprobacionesBackofficePage"));
const ConfiguracionPage = lazy(() => import("@/pages/ConfiguracionPage"));

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
          <AuthProvider>
            <RouteErrorBoundary>
              <Suspense fallback={<LoadingScreen />}>
                <Routes>
                  {/* Ronda 7: landing pública real (ver LandingPage.tsx) en
                      vez de una redirección ciega a /panel — un usuario SIN
                      sesión que llega a "/" debe ver la propuesta de valor,
                      no un salto directo a /login. LandingPage.tsx redirige
                      por su cuenta a /panel cuando SÍ hay sesión activa
                      (mismo patrón que LoginPage.tsx). */}
                  <Route path="/" element={<LandingPage />} />
                  <Route path="/login" element={<LoginPage />} />
                  {/* REQ-172 (ronda 8a): registro real con los dos métodos —
                      `POST /auth/register` (email+contraseña) y "Registrarme
                      con Google" (mismo botón que /login). Pública, como
                      /login: quien se registra todavía no tiene sesión. */}
                  <Route path="/registro" element={<RegistroPage />} />
                  {/* REQ-172..180: pública a propósito, como /login — un login
                      con Google en curso, por definición, todavía no tiene
                      sesión. `GOOGLE_REDIRECT_URI` (apps/api) apunta AQUÍ,
                      nunca a apps/api directo — ver GoogleCallbackPage.tsx. */}
                  <Route path="/auth/google/callback" element={<GoogleCallbackPage />} />
                  {/* REQ-119/131: accesible SIN sesión, como cualquier aviso de
                      privacidad real (debe poder consultarse antes de crear
                      una cuenta). */}
                  <Route path="/privacidad" element={<PrivacyNoticePage />} />
                  {/* Ronda 7: mismo criterio que /privacidad -- términos de
                      servicio también deben poder consultarse sin sesión. */}
                  <Route path="/legal/terminos" element={<TermsPage />} />
                  {/* Ronda 7 (REQ §34.4): demo de solo lectura con datos de
                      ejemplo servidos por MSW SOLO en esta ruta -- pública,
                      sin sesión, ver DemoPage.tsx. */}
                  <Route path="/demo" element={<DemoPage />} />
                  {/* W-12: todo lo que cuelga de <AppShell/> exige sesión real
                      (ver components/auth/RequireAuth.tsx) — la barrera de
                      verdad sigue siendo la API en cada petición. */}
                  <Route element={<RequireAuth />}>
                    {/* Ronda 7: wizard de bienvenida tras el primer login
                        (sin organizaciones todavía) -- fuera de <AppShell/> a
                        propósito (layout de pantalla completa, sin sidebar
                        de un panel que aún no tiene datos que mostrar). Ver
                        RequireAuth.tsx para la redirección automática. */}
                    <Route path="/onboarding" element={<OnboardingPage />} />
                    {/* D-09/ronda 8: compuerta `sin_acceso` -- ver
                        SinAccesoPage.tsx y RequireOrganization en
                        components/auth/RequireAuth.tsx. Ruta hermana de
                        /onboarding, fuera de <AppShell/> por el mismo
                        motivo (nada real de negocio que mostrar todavía). */}
                    <Route path="/sin-acceso" element={<SinAccesoPage />} />
                    <Route element={<RequireOrganization />}>
                      <Route element={<AppShell />}>
                        <Route path="/panel" element={<PanelPage />} />
                        <Route path="/empresa/perfil-capacidades" element={<PerfilCapacidadesPage />} />
                        <Route path="/empresa/documentos-vigencias" element={<DocumentosVigenciasPage />} />
                        <Route path="/empresa/firmantes-autorizados" element={<FirmantesAutorizadosPage />} />
                        <Route path="/empresa/tarifas-aprobadas" element={<TarifasAprobadasPage />} />
                        <Route path="/convocatorias/descubrimiento" element={<DescubrimientoPage />} />
                        <Route path="/convocatorias/descubrimiento/:tenderId" element={<ConvocatoriaDetallePage />} />
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
                        <Route path="/backoffice/conectores" element={<ConectoresPage />} />
                        <Route path="/backoffice/jobs" element={<JobsPage />} />
                        <Route path="/backoffice/costos" element={<CostosPage />} />
                        <Route path="/backoffice/incidentes" element={<IncidentesPage />} />
                        <Route path="/backoffice/aprobaciones" element={<AprobacionesBackofficePage />} />
                        <Route path="/configuracion" element={<ConfiguracionPage />} />
                      </Route>
                    </Route>
                  </Route>
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
