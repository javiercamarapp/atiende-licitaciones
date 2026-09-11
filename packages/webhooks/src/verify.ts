/**
 * REQ-096: verificador genérico de webhooks HMAC entrantes, reutilizable
 * por CUALQUIER webhook nuevo. Compone, en el mismo orden que ya usaba el
 * único webhook entrante real del repo (`@atiende/mail`, esquema Svix de
 * Resend):
 *
 *   1. Ventana de tiempo (si el proveedor manda timestamp) — rechaza un
 *      reenvío tardío o un reloj desincronizado ANTES de comparar la firma.
 *   2. Firma HMAC sobre el contenido firmado que arme el proveedor
 *      (`buildSignedContent`) — ver `hmac.ts`.
 *   3. Deduplicación por `eventId` contra un `WebhookReplayGuard` (si se
 *      pasa uno) — SOLO se reclama el `eventId` cuando la firma ya fue
 *      válida: una firma que nunca fue válida no debe "gastar" el
 *      `eventId` de una petición legítima futura con el mismo id.
 *
 * Lo que SÍ varía por proveedor (nombres de cabecera, cómo se separan los
 * candidatos de un header con varias firmas, cómo se decodifica el
 * secreto, si hay timestamp o no) queda fuera de esta función a propósito
 * — eso vive en el adaptador de cada proveedor concreto (ver
 * `@atiende/mail/webhooks/verify-signature.ts` para el de Resend/Svix, y
 * `apps/api/src/lib/webhooks/hmac-webhook-guard.ts` para el que expone esto
 * como middleware de Fastify).
 */
import type { HmacEncoding } from "./hmac";
import { matchesAnyHmacSignature } from "./hmac";
import type { WebhookReplayGuard } from "./replay-guard";

export type WebhookVerificationFailureReason =
  | "firma_invalida"
  | "timestamp_fuera_de_rango"
  | "replay";

export type WebhookVerificationResult =
  | { ok: true }
  | { ok: false; reason: WebhookVerificationFailureReason };

export interface VerifyHmacWebhookInput {
  /** Cuerpo CRUDO recibido, tal cual — nunca el resultado de re-serializar un `JSON.parse`. */
  rawBody: string;
  /** Identificador de esta entrega concreta (p. ej. `svix-id`, `X-Request-Id`), usado para deduplicar. */
  eventId: string;
  /** Candidatos de firma ya extraídos del header correspondiente, en la codificación `encoding`. */
  signatureCandidates: readonly string[];
  /** Llave HMAC ya decodificada (nunca el secreto en texto plano tal cual llega del proveedor). */
  secret: Buffer;
  /** Arma el contenido exacto que el proveedor firmó, a partir del cuerpo crudo y el `eventId`. */
  buildSignedContent: (rawBody: string, eventId: string) => string;
  encoding: HmacEncoding;
  /** Segundos de tolerancia si `timestampSeconds` viene definido. Default 300 (recomendación de Svix). */
  toleranceSeconds?: number;
  now?: () => number;
  /** Timestamp del proveedor, en segundos Unix. Omitir si el esquema no manda timestamp (no hay ventana de tiempo que aplicar). */
  timestampSeconds?: number;
  /** Si se pasa, cierra la ventana de replay dentro de la tolerancia (ver replay-guard.ts). Omitir para verificar solo la firma. */
  replayGuard?: WebhookReplayGuard;
}

/**
 * `true` si `timestampSeconds` (segundos Unix del proveedor) cae dentro de
 * `toleranceSeconds` respecto de `nowMs` (milisegundos Unix). Se expone por
 * separado porque un adaptador de proveedor con firma SÍNCRONA (como
 * `verifyResendWebhookSignature` de `@atiende/mail`, que no puede volverse
 * `async` sin romper su API pública) necesita el mismo chequeo sin pasar
 * por `verifyHmacWebhookSignature` (que sí es `async`, por el
 * `WebhookReplayGuard` opcional).
 */
export function isWithinTolerance(timestampSeconds: number, nowMs: number, toleranceSeconds: number): boolean {
  const skewSeconds = Math.abs(nowMs / 1000 - timestampSeconds);
  return skewSeconds <= toleranceSeconds;
}

export async function verifyHmacWebhookSignature(input: VerifyHmacWebhookInput): Promise<WebhookVerificationResult> {
  const toleranceSeconds = input.toleranceSeconds ?? 300;
  const now = input.now ? input.now() : Date.now();

  if (input.timestampSeconds !== undefined && !isWithinTolerance(input.timestampSeconds, now, toleranceSeconds)) {
    return { ok: false, reason: "timestamp_fuera_de_rango" };
  }

  const signedContent = input.buildSignedContent(input.rawBody, input.eventId);
  const matched = matchesAnyHmacSignature(signedContent, input.signatureCandidates, input.secret, input.encoding);
  if (!matched) return { ok: false, reason: "firma_invalida" };

  if (input.replayGuard) {
    const claimed = await input.replayGuard.claim(input.eventId, toleranceSeconds, now);
    if (!claimed) return { ok: false, reason: "replay" };
  }

  return { ok: true };
}
