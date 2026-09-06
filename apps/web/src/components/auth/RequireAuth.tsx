import { Navigate, Outlet, useLocation } from "react-router-dom";

import { useAuth } from "@/hooks/useAuth";
import { AtiendeMark } from "@/components/AtiendeLogo";

/**
 * Guarda de rutas (W-12): protege todo lo que cuelga de <AppShell/>. La
 * barrera REAL sigue siendo la API (cada endpoint exige `Authorization:
 * Bearer` y valida membresía/rol en el servidor, ver
 * apps/api/src/plugins/auth.plugin.ts) — esto solo evita que un usuario sin
 * sesión vea el layout del panel antes de que la primera petición falle.
 */
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return (
      <div role="status" aria-label="Comprobando sesión" className="flex min-h-screen items-center justify-center bg-background">
        <AtiendeMark className="atiende-respira h-10 w-auto" animado />
      </div>
    );
  }

  if (status === "unauthenticated") {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <Outlet />;
}

/**
 * Ronda 7: variante de RequireAuth para todo lo que cuelga de <AppShell/>
 * (el panel real, no /onboarding, que es una ruta hermana bajo el mismo
 * <RequireAuth/> y nunca queda envuelta por este componente). Un usuario
 * recién registrado que todavía no pertenece a NINGUNA organización no
 * tiene nada real que ver en el panel (cada pantalla de negocio exige
 * `currentOrgId` -- ver useAuth.tsx): en vez de dejarlo aterrizar en un
 * panel vacío sin explicación, se le manda directo al wizard de bienvenida
 * (OnboardingPage.tsx), cuyo primer paso es exactamente crear esa
 * organización. Una vez que ya tiene alguna organización, puede volver a
 * /onboarding libremente (p. ej. para crear una organización adicional)
 * sin que esta guarda se lo impida.
 */
export function RequireOrganization() {
  const { memberships } = useAuth();

  if (memberships.length === 0) {
    return <Navigate to="/onboarding" replace />;
  }

  return <Outlet />;
}
