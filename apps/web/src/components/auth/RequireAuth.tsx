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
 * Ronda 7 (revisada en ronda 8, D-09/REQ-172..180): variante de RequireAuth
 * para todo lo que cuelga de <AppShell/> (el panel real, no /onboarding ni
 * /sin-acceso, rutas hermanas bajo el mismo <RequireAuth/> que nunca quedan
 * envueltas por este componente). Un usuario autenticado que todavía no
 * pertenece a NINGUNA organización no tiene nada real que ver en el panel
 * (cada pantalla de negocio exige `currentOrgId` -- ver useAuth.tsx).
 *
 * Ronda 7 mandaba directo a `/onboarding` (que asumía de entrada que el
 * usuario quería crear una organización). Ronda 8 lo cambia a `/sin-acceso`
 * (mismo patrón `SIN_ROL`/`/sin-acceso` de Likida, ver
 * docs/investigacion/likida-arquitectura.md y D-09 en docs/DECISIONES.md):
 * el motivo original es el login con Google de un email nuevo (Google no
 * aporta razón social ni RFC -- crear una organización con datos inventados
 * violaría "nunca inventar datos"), pero la misma defensa en profundidad
 * aplica igual de bien a una cuenta registrada por email+contraseña -- una
 * sesión válida nunca debe derivar en una organización que el usuario no
 * pidió explícitamente, sin importar el método de login. `/sin-acceso`
 * ofrece los dos caminos reales (crear la organización -- que lleva aquí
 * mismo, a `/onboarding` -- o pedir invitación) en vez de asumir uno de los
 * dos. Una vez que el usuario ya tiene alguna organización, puede volver a
 * /onboarding libremente (p. ej. para crear una organización adicional) sin
 * que esta guarda se lo impida.
 */
export function RequireOrganization() {
  const { memberships } = useAuth();

  if (memberships.length === 0) {
    return <Navigate to="/sin-acceso" replace />;
  }

  return <Outlet />;
}
