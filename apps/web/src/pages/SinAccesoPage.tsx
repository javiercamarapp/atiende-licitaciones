import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { Building2, LogOut, Mail, ShieldAlert } from "lucide-react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { SkipLink } from "@/components/SkipLink";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "@/components/ui/sonner";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

/**
 * D-09 (docs/DECISIONES.md): compuerta `sin_acceso` — mismo patrón
 * `SIN_ROL`/`/sin-acceso` de Likida (docs/investigacion/likida-arquitectura.md).
 * Un usuario autenticado sin NINGUNA organización aterriza aquí en vez de un
 * panel vacío o un wizard que asume de entrada que quiere crear una
 * organización: se le ofrecen los dos caminos reales de forma explícita.
 * `RequireOrganization` (components/auth/RequireAuth.tsx) redirige aquí —
 * reemplaza el salto directo a `/onboarding` que existía desde ronda 7.
 *
 * Motivo original (D-09, login con Google de un email nuevo): Google no
 * aporta razón social ni RFC, así que crear una organización con datos
 * inventados violaría la regla "nunca inventar datos" — el onboarding real
 * (que SÍ pide esos datos al usuario) solo arranca si el usuario elige
 * explícitamente "Crear mi organización". El mismo razonamiento aplica
 * igual de bien a una cuenta registrada por email+contraseña: nadie debe
 * terminar con una organización que no pidió, sea cual sea el método de
 * login.
 */
export default function SinAccesoPage() {
  useDocumentMeta({ title: "Sin organización" });
  const { memberships, logout, refreshMemberships } = useAuth();
  const navigate = useNavigate();
  const [checkingInvitation, setCheckingInvitation] = useState(false);

  // Si mientras el usuario está en esta pantalla otra pestaña/proceso ya le
  // dio acceso a una organización (p. ej. aceptó una invitación desde el
  // correo en otra pestaña), no tiene sentido seguir mostrando esta
  // compuerta.
  if (memberships.length > 0) {
    return <Navigate to="/panel" replace />;
  }

  const onCheckInvitation = async () => {
    setCheckingInvitation(true);
    try {
      await refreshMemberships();
      // `refreshMemberships` actualiza el estado de `AuthProvider`, pero
      // esta clausura sigue viendo el `memberships` de este render — se lee
      // el resultado real de `GET /organizations` en vez de asumir.
      toast.info("Seguimos sin encontrar ninguna organización para tu cuenta. Si ya te invitaron, confírmalo con quien te invitó.");
    } catch (err) {
      toast.error(describeApiError(err));
    } finally {
      setCheckingInvitation(false);
    }
  };

  return (
    <>
      <SkipLink targetId="sin-acceso-main">Saltar al contenido principal</SkipLink>
      <div className="min-h-screen bg-muted/30">
        <header className="border-b border-border bg-card">
          <div className="container flex h-16 items-center justify-between">
            <AtiendeWordmark />
            <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={() => void logout()}>
              <LogOut className="h-4 w-4" aria-hidden="true" />
              Cerrar sesión
            </Button>
          </div>
        </header>

        <main id="sin-acceso-main" tabIndex={-1} className="container max-w-2xl py-10 focus-visible:outline-none">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-warning/10 text-warning">
            <ShieldAlert className="h-6 w-6" aria-hidden="true" strokeWidth={1.75} />
          </div>
          <h1 className="font-display text-2xl font-semibold text-foreground">Tu cuenta no está vinculada a ninguna organización</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Con sesión iniciada, pero sin ningún rol en una organización de Atiende Licitaciones todavía, no hay convocatorias, documentos ni
            equipo que mostrarte — nada de esto es un error de la cuenta, es una medida de seguridad real: ninguna sesión otorga acceso a datos
            de una organización sin una membresía real.
          </p>

          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Building2 className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
                </div>
                <CardTitle level={2} className="text-lg">
                  Crear mi organización
                </CardTitle>
                <CardDescription>
                  Si tu empresa todavía no usa Atiende Licitaciones, créala tú — te pedimos su nombre real (nunca inventamos datos por ti) y
                  continuamos el resto del asistente de bienvenida.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button asChild className="w-full">
                  <Link to="/onboarding">Crear mi organización</Link>
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Mail className="h-5 w-5" aria-hidden="true" strokeWidth={1.75} />
                </div>
                <CardTitle level={2} className="text-lg">
                  Pedir invitación
                </CardTitle>
                <CardDescription>
                  Si tu empresa ya usa Atiende Licitaciones, pide a quien administra la cuenta (rol Owner o Admin) que te invite con este mismo
                  correo desde <strong>Usuarios y roles</strong>. En cuanto aceptes esa invitación, vuelve aquí.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button type="button" variant="outline" className="w-full" onClick={() => void onCheckInvitation()} disabled={checkingInvitation}>
                  {checkingInvitation ? "Comprobando…" : "Ya me invitaron, continuar"}
                </Button>
              </CardContent>
            </Card>
          </div>

          <p className="mt-6 text-xs text-muted-foreground">
            ¿Entraste por error con otra cuenta?{" "}
            <button
              type="button"
              className="font-medium text-primary underline-offset-4 hover:underline"
              onClick={() => {
                void logout();
                navigate("/login", { replace: true });
              }}
            >
              Cierra sesión e inicia con la cuenta correcta
            </button>
            .
          </p>
        </main>
      </div>
    </>
  );
}
