import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CheckCircle2 } from "lucide-react";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { ResendVerificationForm } from "@/components/auth/ResendVerificationForm";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { readSignedLinkParams, verifyEmail } from "@/lib/api/mail";
import { describeApiError } from "@/hooks/useAuth";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

type Estado = "verificando" | "ok" | "enlace-incompleto" | "error";

/**
 * Los motivos posibles del ÚNICO 400 que devuelve `POST /auth/email/verify`.
 * La API no distingue entre ellos a propósito (vencido, ya usado, firma
 * alterada, cuenta borrada dan el mismo mensaje) para no decirle a quien
 * prueba enlaces al azar cuándo acertó el formato — así que esta pantalla
 * los enumera en vez de inventar cuál fue.
 */
const MOTIVOS_ENLACE_INVALIDO = [
  "Ya venció: los enlaces de confirmación viven 30 minutos.",
  "Ya se usó: cada enlace sirve una sola vez (si ya confirmaste, entra directo).",
  "Se copió incompleto desde el correo, o se alteró en el camino.",
];

/**
 * REQ-181 (ronda 8b): pantalla a la que aterriza el enlace del correo de
 * confirmación, `/verificar-correo?d=…&s=…`. La ruta la fija `apps/api` al
 * firmar el enlace (`sendEmailVerification` → `signedLink(publicUrl,
 * '/verificar-correo', …)`), no esta pantalla.
 *
 * Confirma en cuanto se monta, sin pedir un clic más: quien abre el enlace
 * ya expresó su intención al hacerlo. Es seguro porque el que consume el
 * token es un POST (`/auth/email/verify`): un escáner de enlaces del
 * proveedor de correo que hiciera GET a esta URL cargaría la SPA pero no
 * gastaría el token por su cuenta... salvo que ejecutara JavaScript. Ese
 * riesgo residual es exactamente el mismo que asume el diseño del backend
 * (el token es de un solo uso y solo confirma un correo, no da acceso), y
 * la alternativa —un botón "confirmar"— añade fricción sin cerrar nada: el
 * escáner que ejecuta JS también puede hacer clic.
 *
 * `StrictMode` monta dos veces en desarrollo: `intentado` (un `ref`, no un
 * estado) evita la SEGUNDA llamada, que consumiría un token ya gastado por
 * la primera y pintaría "enlace inválido" sobre un enlace perfectamente
 * bueno.
 */
export default function VerificarCorreoPage() {
  useDocumentMeta({ title: "Confirmar correo" });
  const [searchParams] = useSearchParams();
  // `useMemo` sobre la query serializada, no sobre el objeto: sin esto
  // `link` sería una referencia NUEVA en cada render y el efecto de abajo
  // se reprogramaría (con su limpieza) en cada `setState`.
  const query = searchParams.toString();
  const link = useMemo(() => readSignedLinkParams(query), [query]);
  const [estado, setEstado] = useState<Estado>(link ? "verificando" : "enlace-incompleto");
  const [error, setError] = useState<string | null>(null);
  const intentado = useRef(false);

  useEffect(() => {
    if (!link || intentado.current) return;
    intentado.current = true;
    let cancelado = false;
    void (async () => {
      try {
        await verifyEmail(link);
        if (!cancelado) setEstado("ok");
      } catch (err) {
        if (cancelado) return;
        setError(describeApiError(err));
        setEstado("error");
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [link]);

  if (estado === "ok") {
    return (
      <AuthScreen
        eyebrow="Cuenta confirmada"
        title="Listo, tu correo quedó confirmado"
        intro="Ya puedes iniciar sesión con tu correo y contraseña."
        contentId="verificar-ok"
        skipLabel="Saltar al acceso"
      >
        <div className="space-y-4">
          <div role="status" className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4 text-sm">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p className="text-muted-foreground">
              Este enlace ya se consumió: si vuelves a abrirlo dirá que no es válido, y es lo correcto — cada enlace de
              confirmación sirve una sola vez.
            </p>
          </div>
          <Button asChild className="w-full">
            <Link to="/login">Iniciar sesión</Link>
          </Button>
        </div>
      </AuthScreen>
    );
  }

  if (estado === "verificando") {
    return (
      <AuthScreen
        eyebrow="Confirmando"
        title="Confirmando tu correo…"
        intro="Estamos consumiendo el enlace que abriste. Toma un momento."
        contentId="verificar-cargando"
        skipLabel="Saltar al estado de confirmación"
      >
        <LoadingState label="Confirmando tu correo…" />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      eyebrow="Confirmar correo"
      title={estado === "enlace-incompleto" ? "Este enlace llegó incompleto" : "Este enlace ya no sirve"}
      intro={
        estado === "enlace-incompleto"
          ? "Le faltan los parámetros firmados que lo identifican. Suele pasar cuando el cliente de correo corta la URL en dos líneas: cópiala completa, o pide un enlace nuevo aquí abajo."
          : "El servidor lo rechazó. No nos dice cuál de estos motivos fue —a propósito, para no darle pistas a quien pruebe enlaces al azar—, pero solo puede ser uno de estos:"
      }
      contentId="verificar-error"
      skipLabel="Saltar al reenvío del enlace"
    >
      <div className="space-y-5">
        {estado === "error" && (
          <ul className="space-y-2 rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
            {MOTIVOS_ENLACE_INVALIDO.map((motivo) => (
              <li key={motivo}>{motivo}</li>
            ))}
          </ul>
        )}
        {error && <ErrorState message={error} />}

        <ResendVerificationForm />

        <p className="text-sm text-muted-foreground">
          ¿Ya lo habías confirmado?{" "}
          <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
            Inicia sesión
          </Link>
          .
        </p>
      </div>
    </AuthScreen>
  );
}
