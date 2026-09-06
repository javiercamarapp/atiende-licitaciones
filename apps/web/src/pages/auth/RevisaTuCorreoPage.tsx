import { Link, useLocation } from "react-router-dom";
import { MailWarning } from "lucide-react";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { ResendVerificationForm } from "@/components/auth/ResendVerificationForm";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

/**
 * Estado de la navegación con que llegan a esta pantalla `/registro` y
 * `/login`. Va en `state` de react-router y NUNCA en la query: el correo es
 * un dato personal y una URL termina en el historial del navegador, en el
 * `Referer` de cualquier recurso externo y en cualquier registro de acceso
 * intermedio. El precio de esa decisión es que al recargar se pierde — el
 * formulario de reenvío simplemente aparece vacío, que es un estado
 * perfectamente utilizable, no un error.
 */
export interface RevisaTuCorreoState {
  email?: string;
  /** `registro` = acaba de crear la cuenta; `login` = la compuerta 403 lo mandó aquí. */
  motivo?: "registro" | "login";
}

/**
 * REQ-181 (ronda 8b): las DOS puertas por las que se llega a "confirma tu
 * correo", en una sola pantalla porque lo que hay que hacer es idéntico:
 *
 *  1. **Tras registrarse.** `POST /auth/register` dispara el correo de
 *     verificación (sin esperarlo). Ojo con lo que esta pantalla NO dice:
 *     ese endpoint responde 201 exista o no ya el correo (antienumeración,
 *     API-03), así que afirmar "creamos tu cuenta" sería inventar — el
 *     texto habla del correo, que es lo único cierto en ambos casos.
 *  2. **Tras un login bloqueado por la compuerta.** `POST /auth/login`
 *     responde `403 email-not-verified` DESPUÉS de validar la contraseña
 *     (ver apps/api/README.md § "La compuerta de POST /auth/login"): llegar
 *     aquí desde el login ya probó que quien lo intentó es el dueño de la
 *     cuenta, así que mostrarle su propio correo no filtra nada.
 *
 * La compuerta puede estar APAGADA en el despliegue
 * (`REQUIRE_EMAIL_VERIFICATION=false`, el escape documentado para un
 * entorno sin proveedor de correo). En ese caso nadie llega aquí desde el
 * login y el aviso tras registrarse sigue siendo cierto igual: el correo se
 * manda de todas formas.
 */
export default function RevisaTuCorreoPage() {
  useDocumentMeta({ title: "Confirma tu correo" });
  const location = useLocation();
  const state = (location.state ?? null) as RevisaTuCorreoState | null;
  const desdeLogin = state?.motivo === "login";

  return (
    <AuthScreen
      eyebrow={desdeLogin ? "Acceso bloqueado" : "Casi listo"}
      title={desdeLogin ? "Confirma tu correo para entrar" : "Revisa tu correo"}
      intro={
        desdeLogin
          ? "Tu contraseña es correcta, pero la cuenta todavía no tiene el correo confirmado. Abre el enlace que te mandamos al registrarte, o pide uno nuevo aquí abajo."
          : "Te mandamos un enlace de confirmación. Ábrelo desde este dispositivo o desde cualquier otro: en cuanto lo confirmes podrás iniciar sesión."
      }
      contentId="revisa-correo"
      skipLabel="Saltar a las opciones de confirmación"
    >
      <div className="space-y-5">
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4 text-sm">
          <MailWarning className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <div className="space-y-2 text-muted-foreground">
            {state?.email ? (
              <p>
                Enviado a <span className="font-medium text-foreground">{state.email}</span>.
              </p>
            ) : (
              <p>Si no recuerdas con qué correo te registraste, escríbelo abajo para que te reenviemos el enlace.</p>
            )}
            <p>El enlace vive 30 minutos y solo se puede usar una vez. Si venció, pide otro desde aquí.</p>
          </div>
        </div>

        <ResendVerificationForm defaultEmail={state?.email ?? ""} />

        <p className="text-sm text-muted-foreground">
          ¿Ya lo confirmaste?{" "}
          <Link to="/login" className="font-medium text-primary underline-offset-4 hover:underline">
            Inicia sesión
          </Link>
          .
        </p>
      </div>
    </AuthScreen>
  );
}
