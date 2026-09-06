/**
 * LA PLANTILLA BASE — el layout de todo correo transaccional de Atiende.
 *
 * Un correo no es una página web. Gmail borra el `<style>` del `<head>`,
 * Outlook de escritorio renderiza con el motor de Word (sin flexbox, sin
 * grid, sin `border-radius` fiable), y casi todos los clientes bloquean las
 * imágenes hasta que el lector las autoriza. Por eso:
 *
 *   · todo el CSS de los bloques va EN LÍNEA (ver `components/blocks.tsx`);
 *   · la estructura son tablas anidadas — lo que ya generan los componentes
 *     de `@react-email/components` (`Section`/`Row`/`Column` son `<table>`,
 *     no `<div>`) — así que el motor de plantillas no pelea contra el medio;
 *   · el ancho es fijo (600px, `EMAIL_WIDTH`), el estándar que todos los
 *     clientes respetan;
 *   · nada de `var(--token)`: los colores viajan como literales de
 *     `theme.ts` (ver ese archivo para el mapeo con los tokens de la app).
 *
 * EL ENCABEZADO ES UN WORDMARK DE TEXTO, no una imagen ni un SVG inline —
 * ver `AtiendeLogo.tsx` para el porqué completo (Gmail descarta `<svg>` de
 * un correo por completo; un logo enlazado a una URL depende de que el
 * cliente autorice imágenes externas, que es el default bloqueado para un
 * remitente nuevo). Cuando exista un PNG oficial de Atiende, `logoCid`
 * permite pasar a un `<img src="cid:...">` sin tocar el resto del layout.
 *
 * PIE OBLIGATORIO. Todo correo lleva por qué le llegó y, cuando la categoría
 * lo permite, cómo dejar de recibirlo — es lo que separa un correo
 * transaccional de uno que los filtros de un remitente masivo (Gmail/Yahoo)
 * tratan como campaña. La dirección postal/razón social del pie está
 * marcada como PLACEHOLDER: son datos fiscales reales pendientes del
 * usuario, no algo que este paquete pueda inventar.
 */
import * as React from "react";
import { Head, Html, Img, Preview, Section, Text, Link } from "@react-email/components";
import { colors, EMAIL_WIDTH, fonts } from "../theme";
import { AtiendeWordmarkText } from "./AtiendeLogo";
import { ToneBadge } from "./blocks";
import type { ToneKey } from "../theme";
import { safeUrl } from "../security/safe-url";

/**
 * Placeholder legal explícito del pie (razón social + domicilio fiscal).
 * REQ (ronda 6): "pie con dirección/legal placeholder marcado" — este texto
 * se sustituye por los datos fiscales reales de Atiende antes de producción;
 * hasta entonces queda visible como pendiente, nunca inventado.
 */
export const LEGAL_FOOTER_PLACEHOLDER =
  "Atiende Licitaciones · [Razón social pendiente] · [Domicilio fiscal pendiente — completar antes de producción]";

export interface EmailLayoutProps {
  /** Título de la pestaña / `<title>` del documento (no el asunto del envío
   *  en sí, aunque normalmente coinciden). */
  documentTitle: string;
  /** El renglón bajo el asunto en la bandeja de entrada (preheader). */
  preheader: string;
  tone?: ToneKey;
  /** Por qué le llegó este correo a la persona — va al pie, siempre. */
  reason: string;
  appUrl: string;
  supportEmail: string;
  /** Liga firmada al centro de preferencias de notificación. Ausente solo en
   *  correos de seguridad de cuenta (verificación, contraseña, 2FA), que no
   *  se pueden apagar por preferencia. */
  preferencesUrl?: string;
  /**
   * Enlace de baja DENTRO DEL CUERPO del correo (art. 16 fr. II LFPDPPP).
   * Solo en categorías no obligatorias (alertas de convocatorias, resúmenes).
   *
   * ML-02: esto NO es, por sí solo, la "baja de un clic" de RFC 8058 — esa
   * norma define las cabeceras `List-Unsubscribe`/`List-Unsubscribe-Post`
   * (el botón nativo que Gmail/Yahoo pintan junto al remitente), que
   * `MailService.send()` calcula y pasa por separado al `MailProvider`
   * (ver `service/list-unsubscribe.ts`) — este enlace del cuerpo es el
   * respaldo visible para quien lee el correo completo, no un sustituto de
   * esas cabeceras.
   */
  unsubscribeUrl?: string;
  /**
   * Content-ID de un logo adjunto (ver `provider/types.ts#OutboundAttachment`),
   * cuando `MailService` lo agrega al envío. Sin esto (el caso de hoy, sin
   * un PNG oficial de Atiende), el encabezado es el wordmark de texto — ver
   * el comentario de cabecera de este archivo y de `AtiendeLogo.tsx`.
   */
  logoCid?: string;
  children: React.ReactNode;
}

export function EmailLayout({
  documentTitle,
  preheader,
  tone,
  reason,
  appUrl,
  supportEmail,
  preferencesUrl,
  unsubscribeUrl,
  logoCid,
  children,
}: EmailLayoutProps): React.ReactElement {
  const bareAppUrl = appUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return (
    <Html lang="es">
      <Head>
        <title>{documentTitle}</title>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light only" />
      </Head>
      <Preview>{preheader}</Preview>
      <body style={{ margin: 0, padding: 0, backgroundColor: colors.canvas }}>
        <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ backgroundColor: colors.canvas }}>
          <tbody>
            <tr>
              <td align="center" style={{ padding: "44px 16px 36px 16px" }}>
                <table
                  role="presentation"
                  align="center"
                  cellPadding={0}
                  cellSpacing={0}
                  width={EMAIL_WIDTH}
                  style={{ width: EMAIL_WIDTH, maxWidth: "100%", borderCollapse: "collapse" }}
                >
                  {/* Encabezado: el glifo de Atiende, arriba a la izquierda. */}
                  <tbody>
                    <tr>
                      <td align="left" style={{ padding: "0 0 26px 2px" }}>
                        {logoCid ? (
                          // El alt LLEVA ESTILO (mismo recurso que Likida): si el
                          // cliente bloquea la imagen `cid:`, la mayoría aplica los
                          // estilos del <img> a su alt, y el peor caso sigue siendo
                          // presentable — el wordmark de marca, no un ícono roto.
                          <Img
                            src={`cid:${logoCid}`}
                            alt="atiende"
                            width={112}
                            height={23}
                            style={{
                              display: "block",
                              height: 23,
                              width: 112,
                              fontFamily: fonts.display,
                              fontSize: 15,
                              fontWeight: 700,
                              letterSpacing: "0.02em",
                              color: colors.brand,
                            }}
                          />
                        ) : (
                          <AtiendeWordmarkText />
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td
                        style={{
                          backgroundColor: colors.surface,
                          padding: "42px 44px 38px 44px",
                          border: `1px solid ${colors.line}`,
                          borderRadius: 16,
                        }}
                      >
                        <ToneBadge tone={tone} />
                        {children}
                      </td>
                    </tr>
                    <tr>
                      <td align="left" style={{ padding: "26px 6px 0 6px" }}>
                        <Text
                          style={{
                            margin: "0 0 7px 0",
                            fontFamily: fonts.sans,
                            fontSize: 11,
                            lineHeight: "17px",
                            fontWeight: 600,
                            letterSpacing: "0.08em",
                            textTransform: "uppercase",
                            color: colors.muted,
                          }}
                        >
                          Atiende&nbsp;&nbsp;&#183;&nbsp;&nbsp;Licitaciones
                        </Text>
                        <Text style={{ margin: "0 0 5px 0", fontFamily: fonts.sans, fontSize: 11, lineHeight: "18px", color: colors.faint }}>
                          {reason}
                        </Text>
                        <Text style={{ margin: "0 0 5px 0", fontFamily: fonts.sans, fontSize: 11, lineHeight: "18px", color: colors.faint }}>
                          <Link href={safeUrl(appUrl, appUrl)} style={{ color: colors.faint, textDecoration: "underline" }}>
                            {bareAppUrl}
                          </Link>
                          {" · "}
                          <Link href={`mailto:${supportEmail}`} style={{ color: colors.faint, textDecoration: "underline" }}>
                            {supportEmail}
                          </Link>
                        </Text>
                        {preferencesUrl ? (
                          <Text style={{ margin: "0 0 2px 0", fontFamily: fonts.sans, fontSize: 11, lineHeight: "18px" }}>
                            <Link href={safeUrl(preferencesUrl, appUrl)} style={{ color: colors.faint, textDecoration: "underline" }}>
                              Administrar preferencias de notificación
                            </Link>
                          </Text>
                        ) : null}
                        {unsubscribeUrl ? (
                          <Text style={{ margin: "0 0 12px 0", fontFamily: fonts.sans, fontSize: 11, lineHeight: "18px" }}>
                            <Link href={safeUrl(unsubscribeUrl, appUrl)} style={{ color: colors.faint, textDecoration: "underline" }}>
                              Darme de baja de estos correos
                            </Link>
                          </Text>
                        ) : null}
                        <Section style={{ margin: "12px 0 0 0" }}>
                          <Text style={{ margin: 0, fontFamily: fonts.sans, fontSize: 10, lineHeight: "15px", color: colors.faint }}>
                            {LEGAL_FOOTER_PLACEHOLDER}
                          </Text>
                        </Section>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </Html>
  );
}
