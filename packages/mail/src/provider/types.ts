/**
 * Un adjunto en línea o normal. El caso de uso principal en este paquete es
 * el logo `cid:` al estilo Likida (`content_disposition: 'inline'` +
 * `contentId` referenciado en el HTML como `cid:<contentId>`) para el día
 * en que exista un PNG oficial de Atiende — ver `components/AtiendeLogo.tsx`.
 * También sirve para adjuntos normales (p. ej. un PDF de expediente), con
 * `disposition: "attachment"`.
 */
export interface OutboundAttachment {
  filename: string;
  /** Contenido en base64. */
  content: string;
  contentType?: string;
  /** Requerido cuando `disposition === "inline"`: es el identificador que el
   *  HTML referencia como `src="cid:<contentId>"`. */
  contentId?: string;
  disposition?: "inline" | "attachment";
}

/** Un correo ya renderizado, listo para pasarle a un `MailProvider`. Las
 *  direcciones en `to` ya pasaron por `assertRegisteredRecipient` en
 *  `MailService` — un provider nunca decide a quién se le puede escribir. */
export interface OutboundEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** Parte local del remitente (`avisos`, `acceso`, etc.) — el dominio lo
   *  decide la configuración del provider, no el llamador. */
  fromLocalPart?: string;
  /** Cabeceras adicionales del mensaje (p. ej. `List-Unsubscribe`). */
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];
  /** Llave de idempotencia que el provider puede deduplicar de su lado
   *  (Resend/Postmark la soportan nativamente). `MailService` ya deduplica
   *  con su propio `SendRecordStore`; esto es una segunda red de seguridad
   *  contra un timeout de red ambiguo. */
  idempotencyKey?: string;
}

export type SendResult =
  | { ok: true; providerMessageId: string }
  /** No hay credenciales configuradas: un estado declarado, no un fallo
   *  silencioso — así lo distingue `correoConfigurado()` en la app real. */
  | { ok: false; kind: "not_configured" }
  /** 429/5xx/timeout de red: vale la pena reintentar. */
  | { ok: false; kind: "retryable"; statusCode?: number; detail: string }
  /** 4xx (remitente rechazado, dominio no verificado, payload inválido):
   *  reintentar no cambia el resultado. */
  | { ok: false; kind: "permanent"; statusCode?: number; detail: string };

export interface MailProvider {
  readonly name: string;
  send(message: OutboundEmail): Promise<SendResult>;
}

/** Clasifica un código HTTP en `retryable`/`permanent`, el mismo criterio
 *  para los tres adaptadores HTTP (Resend, Postmark): 429 y 5xx son
 *  transitorios; el resto de los 4xx son un rechazo definitivo del payload
 *  o la configuración (remitente, dominio, destinatario). */
export function classifyHttpStatus(status: number): "retryable" | "permanent" {
  if (status === 429) return "retryable";
  if (status >= 500) return "retryable";
  return "permanent";
}
