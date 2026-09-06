import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/http";
import { startGoogleLogin } from "@/lib/api/google";
import { describeApiError } from "@/hooks/useAuth";

/** Glifo oficial de Google ("G" multicolor) — SVG en línea: sin dependencia nueva ni red, mismo criterio que `qrcode`/íconos propios del proyecto. */
function GoogleGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6.1 29.6 4 24 4c-7.4 0-13.8 4.2-17 10.3z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.5 0 10.4-2.1 14.1-5.5l-6.5-5.5C29.6 34.7 27 35.7 24 35.7c-5.2 0-9.6-3.3-11.2-7.9l-6.5 5C9.9 39.6 16.4 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.5 5.5C41.5 36 44 30.6 44 24c0-1.3-.1-2.7-.4-3.5z"
      />
    </svg>
  );
}

type ButtonState = "idle" | "loading" | "unavailable";

export interface GoogleAuthButtonProps {
  /** REQ-172: "Continuar con Google" (login) por defecto — el registro reutiliza este mismo componente con otra etiqueta cuando exista una pantalla propia (ver README, "queda para ronda 8b"). */
  label?: string;
}

/**
 * REQ-172/178: botón "Continuar con Google", junto al método de
 * email+contraseña existente (nunca lo reemplaza). Al hacer clic pide
 * `GET /auth/google/start` y navega el navegador COMPLETO a la
 * `authorizationUrl` real (nunca un `fetch` de esa URL — es una redirección
 * de usuario al proveedor, ver docstring de `startGoogleLogin`).
 *
 * REQ-178 (BLOQUEADO_EXTERNO): `apps/api` no expone ninguna señal previa de
 * "Google está configurado" (se comprobó `apps/api/README.md` — no existe
 * tal endpoint) y pedirla por adelantado en cada carga de /login gastaría
 * cupo real del límite de tasa (`tier auth`, 5/min) y dejaría filas
 * `oauth_states` sin usar solo para sondear disponibilidad. Este botón
 * arranca siempre habilitado y se apoya en la respuesta 503 REAL del propio
 * `/auth/google/start` (única señal que la API expone hoy): si llega,
 * pasa a deshabilitado con la explicación exacta del servidor en vez de
 * reintentar una redirección que fallaría igual.
 */
export function GoogleAuthButton({ label = "Continuar con Google" }: GoogleAuthButtonProps) {
  const [state, setState] = useState<ButtonState>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const onClick = async () => {
    setState("loading");
    setMessage(null);
    try {
      const { authorizationUrl } = await startGoogleLogin();
      window.location.assign(authorizationUrl);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        setState("unavailable");
        setMessage(err.message);
        return;
      }
      setState("idle");
      setMessage(describeApiError(err));
    }
  };

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        className="w-full gap-2"
        onClick={() => void onClick()}
        disabled={state === "loading" || state === "unavailable"}
      >
        <GoogleGlyph className="h-4 w-4" />
        {state === "loading" ? "Redirigiendo a Google…" : label}
      </Button>
      {message && (
        <p role={state === "unavailable" ? "status" : "alert"} className="text-xs text-muted-foreground">
          {message}
        </p>
      )}
    </div>
  );
}
