import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { CheckCircle2, Users } from "lucide-react";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { readSignedLinkParams } from "@/lib/api/mail";
import { acceptInvitationFromLink } from "@/lib/api/organizations";
import { useAuth, describeApiError } from "@/hooks/useAuth";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

type Estado = "sin-enlace" | "sin-sesion" | "aceptando" | "ok" | "error";

/**
 * REQ-186 (ronda 8b): pantalla del enlace firmado de invitación,
 * `/invitaciones/aceptar?d=…&s=…` (la ruta la fija `apps/api` al firmar el
 * correo, ver `sendOrganizationInviteEmail`).
 *
 * **Aceptar una invitación EXIGE sesión** — no es una omisión de esta
 * pantalla, es cómo tiene que ser: `POST /organizations/invitations/accept`
 * da de alta a un USUARIO concreto en la organización y comprueba que el
 * correo de la sesión coincide con el de la invitación (401
 * `invitation_email_mismatch` si no). Sin esa comprobación, cualquiera con
 * el enlace entraría a la organización con la identidad que quisiera.
 *
 * De ahí las dos ramas de "crea cuenta si no existe o entra si existe" que
 * pide la tarea: esta pantalla NO crea la cuenta por su cuenta (no tiene
 * contraseña que poner, ni debe inventarla), manda a `/registro` o a
 * `/login` conservando el enlace COMPLETO —con su query firmada— en el
 * `state` de la navegación, y esas dos pantallas devuelven aquí al
 * terminar. El enlace sigue siendo válido: aceptarlo es lo único que lo
 * consume.
 */
export default function AceptarInvitacionPage() {
  useDocumentMeta({ title: "Aceptar invitación" });
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const { status, refreshMemberships } = useAuth();
  const query = searchParams.toString();
  const link = useMemo(() => readSignedLinkParams(query), [query]);
  const [error, setError] = useState<string | null>(null);
  const [aceptada, setAceptada] = useState<{ role: string } | null>(null);
  const [fallo, setFallo] = useState(false);
  const intentado = useRef(false);

  useEffect(() => {
    if (!link || status !== "authenticated" || intentado.current) return;
    intentado.current = true;
    let cancelado = false;
    void (async () => {
      try {
        const result = await acceptInvitationFromLink(link);
        // La membresía nueva tiene que entrar en el contexto de sesión ANTES
        // de ofrecer "Ir al panel": `RequireOrganization` (ver
        // components/auth/RequireAuth.tsx) mira `memberships`, y sin este
        // refresco un usuario recién invitado rebotaría a /sin-acceso justo
        // después de aceptar.
        await refreshMemberships().catch(() => undefined);
        if (!cancelado) setAceptada({ role: result.role });
      } catch (err) {
        if (cancelado) return;
        setError(describeApiError(err));
        setFallo(true);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [link, status, refreshMemberships]);

  const estado: Estado = !link
    ? "sin-enlace"
    : status === "unauthenticated"
      ? "sin-sesion"
      : aceptada
        ? "ok"
        : fallo
          ? "error"
          : "aceptando";

  if (estado === "ok") {
    return (
      <AuthScreen
        eyebrow="Invitación aceptada"
        title="Ya eres parte de la organización"
        intro={`Tu rol es "${aceptada?.role}". Lo que puedes ver y aprobar depende de ese rol, y solo un owner o admin puede cambiarlo.`}
        contentId="invitacion-ok"
        skipLabel="Saltar al panel"
      >
        <div className="space-y-4">
          <div role="status" className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4 text-sm">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p className="text-muted-foreground">
              Este enlace ya se consumió: cada invitación se acepta una sola vez. Si vuelves a abrirlo dirá que ya fue
              aceptada, y es lo correcto.
            </p>
          </div>
          <Button asChild className="w-full">
            <Link to="/panel">Ir al panel</Link>
          </Button>
        </div>
      </AuthScreen>
    );
  }

  if (estado === "sin-sesion") {
    return (
      <AuthScreen
        eyebrow="Invitación a una organización"
        title="Entra o crea tu cuenta para aceptarla"
        intro="La invitación se acepta con la cuenta del correo al que llegó. Si ya tienes cuenta, inicia sesión; si es tu primera vez, créala con ESE mismo correo — la API rechaza la invitación si no coincide."
        contentId="invitacion-sin-sesion"
        skipLabel="Saltar a las opciones de acceso"
      >
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
            <Users className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p>Volverás aquí automáticamente al terminar. El enlace sigue vivo: aceptarlo es lo único que lo consume.</p>
          </div>
          {/* `state.from` lleva la ubicación COMPLETA (ruta + query firmada):
              /login y /registro la reconstruyen tal cual al terminar. Con
              solo el `pathname` se perdería el `?d=…&s=…` y el usuario
              volvería a una pantalla sin invitación que aceptar. */}
          <Button asChild className="w-full">
            <Link to="/login" state={{ from: location }}>
              Ya tengo cuenta: iniciar sesión
            </Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link to="/registro" state={{ from: location }}>
              Crear mi cuenta
            </Link>
          </Button>
        </div>
      </AuthScreen>
    );
  }

  if (estado === "aceptando") {
    return (
      <AuthScreen
        eyebrow="Invitación a una organización"
        title="Aceptando la invitación…"
        intro="Estamos validando el enlace firmado y dándote de alta."
        contentId="invitacion-cargando"
        skipLabel="Saltar al estado de la invitación"
      >
        <LoadingState label="Aceptando la invitación…" />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      eyebrow="Invitación a una organización"
      title={estado === "sin-enlace" ? "Este enlace llegó incompleto" : "No se pudo aceptar la invitación"}
      intro={
        estado === "sin-enlace"
          ? "Le faltan los parámetros firmados que lo identifican. Suele pasar cuando el cliente de correo corta la URL en dos líneas: cópiala completa desde el correo."
          : "El servidor rechazó la invitación. Este es el motivo exacto que devolvió:"
      }
      contentId="invitacion-error"
      skipLabel="Saltar al detalle del error"
    >
      <div className="space-y-4">
        {error && <ErrorState message={error} />}
        <p className="text-sm text-muted-foreground">
          Los motivos reales son cuatro: la invitación ya se aceptó o se revocó, expiró (viven 7 días), el enlace venció o
          se alteró, o llegó a un correo distinto al de tu sesión. Pídele a quien te invitó que la mande de nuevo.
        </p>
        <Button asChild variant="outline" className="w-full">
          <Link to="/panel">Ir al panel</Link>
        </Button>
      </div>
    </AuthScreen>
  );
}
