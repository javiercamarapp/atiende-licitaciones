import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BellOff, CheckCircle2, ShieldCheck } from "lucide-react";

import { AuthScreen } from "@/components/auth/AuthScreen";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/error-state";
import { LoadingState } from "@/components/ui/loading-state";
import { applyUnsubscribe, checkUnsubscribeLink, readSignedLinkParams } from "@/lib/api/mail";
import { describeApiError } from "@/hooks/useAuth";
import { useDocumentMeta } from "@/hooks/useDocumentMeta";

/**
 * Nombre humano de cada categoría APAGABLE, con las mismas claves
 * (snake_case) que devuelve `GET /mail/unsubscribe` — que son las columnas
 * de `notification_preferences` (`OPTIONAL_CATEGORIES` en
 * apps/api/src/lib/mail/preferences.ts). Una categoría desconocida no se
 * inventa: se muestra la clave cruda, que es información real.
 */
const CATEGORIA_BAJA_ETIQUETAS: Record<string, string> = {
  tender_matches: "Convocatorias que coinciden con tu perfil",
  tender_changes: "Cambios en convocatorias que sigues",
  approvals: "Aprobaciones pendientes",
  submission: "Presentación y entrega",
  deadlines: "Plazos próximos a vencer",
  document_expiration: "Vencimiento de documentos de la empresa",
  post_award: "Seguimiento post-adjudicación",
  weekly_summary: "Resumen semanal",
};

/**
 * REQ-187 (ronda 8b): página PÚBLICA de baja de un clic. Aterriza aquí el
 * enlace "Cancelar suscripción" del pie de todo correo opcional
 * (`/preferencias/baja?d=…&s=…`, ruta fijada por `apps/api` en
 * `buildUnsubscribeUrl`); `/unsubscribe` es un alias de la misma pantalla.
 *
 * Sin sesión a propósito: quien se da de baja puede no tener el navegador
 * con la sesión abierta (o no tener cuenta activa). La identidad sale de la
 * firma HMAC del enlace, verificada en el servidor — nunca de un parámetro
 * crudo ni de un correo tecleado aquí.
 *
 * **El GET no da de baja a nadie; el POST sí.** Es la separación que hace
 * `apps/api` (`GET /mail/unsubscribe` solo VALIDA) y esta pantalla la
 * respeta con un botón explícito: un escáner de enlaces del propio
 * proveedor de correo visita las URLs de un mensaje sin que nadie las haya
 * pulsado — si el GET aplicara la baja, apagaría notificaciones que el
 * usuario nunca pidió apagar. (El botón "Cancelar suscripción" NATIVO de
 * Gmail/Yahoo no pasa por esta pantalla: hace su propio POST directo al
 * endpoint, RFC 8058.)
 */
export default function PreferenciasBajaPage() {
  useDocumentMeta({ title: "Cancelar suscripción" });
  const [searchParams] = useSearchParams();
  const query = searchParams.toString();
  const link = useMemo(() => readSignedLinkParams(query), [query]);
  const [categoria, setCategoria] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [enlaceInvalido, setEnlaceInvalido] = useState(!link);
  const [dadoDeBaja, setDadoDeBaja] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const validado = useRef(false);

  useEffect(() => {
    if (!link || validado.current) return;
    validado.current = true;
    let cancelado = false;
    void (async () => {
      try {
        const status = await checkUnsubscribeLink(link);
        if (!cancelado) setCategoria(status.category);
      } catch (err) {
        if (cancelado) return;
        setError(describeApiError(err));
        setEnlaceInvalido(true);
      }
    })();
    return () => {
      cancelado = true;
    };
  }, [link]);

  const onConfirm = async () => {
    if (!link) return;
    setError(null);
    setEnviando(true);
    try {
      await applyUnsubscribe(link);
      setDadoDeBaja(true);
    } catch (err) {
      setError(describeApiError(err));
    } finally {
      setEnviando(false);
    }
  };

  if (enlaceInvalido) {
    return (
      <AuthScreen
        eyebrow="Cancelar suscripción"
        title={link ? "Este enlace de baja ya no sirve" : "Este enlace llegó incompleto"}
        intro={
          link
            ? "El servidor lo rechazó: pudo vencer (los enlaces de baja viven 180 días), venir de una categoría que ya no existe, o haberse alterado en el camino. La API no distingue cuál, a propósito."
            : "Le faltan los parámetros firmados que lo identifican. Cópialo completo desde el correo."
        }
        contentId="baja-invalida"
        skipLabel="Saltar a las opciones de notificaciones"
      >
        <div className="space-y-4">
          {error && <ErrorState message={error} />}
          <p className="text-sm text-muted-foreground">
            Puedes apagar cada categoría desde tu cuenta, sin necesidad de ningún enlace.
          </p>
          <Button asChild className="w-full">
            <Link to="/configuracion">Abrir mis preferencias de notificación</Link>
          </Button>
        </div>
      </AuthScreen>
    );
  }

  if (dadoDeBaja) {
    return (
      <AuthScreen
        eyebrow="Cancelar suscripción"
        title="Listo, dejarás de recibir esos avisos"
        intro={
          categoria
            ? `Apagamos la categoría "${CATEGORIA_BAJA_ETIQUETAS[categoria] ?? categoria}". Las demás siguen activas.`
            : "Apagamos TODAS las categorías opcionales de tu cuenta."
        }
        contentId="baja-ok"
        skipLabel="Saltar al detalle de la baja"
      >
        <div className="space-y-4">
          <div role="status" className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4 text-sm">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <p className="text-muted-foreground">
              Puedes volver a activarlas cuando quieras desde tu cuenta: dar de baja no borra nada, solo apaga el envío.
            </p>
          </div>
          <CorreosDeSeguridadNota />
          <Button asChild variant="outline" className="w-full">
            <Link to="/configuracion">Ajustar el resto de mis notificaciones</Link>
          </Button>
        </div>
      </AuthScreen>
    );
  }

  if (categoria === undefined) {
    return (
      <AuthScreen
        eyebrow="Cancelar suscripción"
        title="Comprobando el enlace…"
        intro="Estamos validando la firma del enlace antes de tocar nada."
        contentId="baja-cargando"
        skipLabel="Saltar al estado del enlace"
      >
        <LoadingState label="Comprobando el enlace de baja…" />
      </AuthScreen>
    );
  }

  return (
    <AuthScreen
      eyebrow="Cancelar suscripción"
      title="¿Confirmas la baja?"
      intro={
        categoria
          ? `Vas a dejar de recibir los correos de la categoría "${CATEGORIA_BAJA_ETIQUETAS[categoria] ?? categoria}". El resto seguirá llegando.`
          : "Vas a apagar TODAS las categorías opcionales de correo de tu cuenta."
      }
      contentId="baja-confirmar"
      skipLabel="Saltar a la confirmación de baja"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
          <BellOff className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
          <p>
            Pedimos este clic a propósito: abrir el enlace no da de baja a nadie, porque los propios proveedores de correo
            visitan las URLs de un mensaje para analizarlas y eso apagaría avisos que nunca pediste apagar.
          </p>
        </div>
        <CorreosDeSeguridadNota />
        {error && <ErrorState message={error} onRetry={() => setError(null)} />}
        <Button type="button" className="w-full" disabled={enviando} onClick={onConfirm}>
          {enviando ? "Aplicando la baja…" : "Sí, darme de baja"}
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link to="/configuracion">Prefiero elegir categoría por categoría</Link>
        </Button>
      </div>
    </AuthScreen>
  );
}

/**
 * REQ-187: la parte honesta que esta página está obligada a decir. Los
 * correos de seguridad de cuenta (`account_security`: confirmación de
 * correo, restablecimiento de contraseña, 2FA activado, códigos de
 * respaldo) NO son apagables — no aparecen en
 * `OPTIONAL_CATEGORIES` de apps/api, y `isCategoryEnabled` de
 * packages/mail ni siquiera consulta las preferencias para ellos. Decirlo
 * aquí evita la queja legítima de "me di de baja y me siguen llegando
 * correos".
 */
function CorreosDeSeguridadNota() {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-border p-4 text-sm">
      <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Los correos de seguridad de la cuenta seguirán llegando</span> y no se
        pueden desactivar: confirmación de correo, restablecimiento de contraseña, activación de la verificación en dos
        pasos y códigos de respaldo. Son los que te avisan si alguien intenta entrar a tu cuenta.
      </p>
    </div>
  );
}
