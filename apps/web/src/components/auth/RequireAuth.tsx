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
