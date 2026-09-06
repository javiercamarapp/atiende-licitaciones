/**
 * Verificación de la firma de webhook de Resend, que usa el esquema de
 * Svix (`docs/investigacion/salida-promocion-referencias.md` §2.2 menciona
 * "firma Svix HMAC" para `POST /api/correo/eventos` de Likida):
 *
 *   contenido_firmado = "${svix-id}.${svix-timestamp}.${cuerpo_crudo}"
 *   firma_esperada    = base64(HMAC-SHA256(contenido_firmado, secreto))
 *
 * El secreto llega con el prefijo `whsec_` seguido del material en base64
 * (tal cual lo entrega el panel de Resend/Svix); se decodifica antes de
 * usarlo como llave HMAC. El header `svix-signature` puede traer varias
 * firmas separadas por espacio (`v1,<firma> v1,<firma2>`, para rotación de
 * secreto) — basta con que UNA coincida.
 *
 * El cuerpo debe ser el texto CRUDO recibido (antes de `JSON.parse`): un
 * solo espacio de diferencia en el re-serializado invalida la firma.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookSignatureHeaders {
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
}

export interface VerifyWebhookOptions {
  /** Segundos de tolerancia contra reloj desincronizado o reenvío tardío.
   *  Svix recomienda 5 minutos; ese es el default. */
  toleranceSeconds?: number;
  now?: () => number;
}

export type VerifyWebhookResult =
  | { ok: true }
  | { ok: false; reason: "secreto_invalido" | "cabeceras_incompletas" | "firma_invalida" | "timestamp_fuera_de_rango" };

export function verifyResendWebhookSignature(
  rawBody: string,
  headers: WebhookSignatureHeaders,
  secret: string,
  options: VerifyWebhookOptions = {},
): VerifyWebhookResult {
  if (!headers.svixId || !headers.svixTimestamp || !headers.svixSignature) {
    return { ok: false, reason: "cabeceras_incompletas" };
  }

  const secretBase64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secretBase64, "base64");
  } catch {
    return { ok: false, reason: "secreto_invalido" };
  }
  if (secretBytes.length === 0) return { ok: false, reason: "secreto_invalido" };

  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? (() => Date.now());
  const timestampSeconds = Number(headers.svixTimestamp);
  if (!Number.isFinite(timestampSeconds)) return { ok: false, reason: "cabeceras_incompletas" };
  const skewSeconds = Math.abs(now() / 1000 - timestampSeconds);
  if (skewSeconds > tolerance) return { ok: false, reason: "timestamp_fuera_de_rango" };

  const signedContent = `${headers.svixId}.${headers.svixTimestamp}.${rawBody}`;
  const expected = createHmac("sha256", secretBytes).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected, "base64");

  const candidates = headers.svixSignature
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter((v): v is string => Boolean(v));

  const matches = candidates.some((candidate) => {
    let candidateBuf: Buffer;
    try {
      candidateBuf = Buffer.from(candidate, "base64");
    } catch {
      return false;
    }
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
  });

  return matches ? { ok: true } : { ok: false, reason: "firma_invalida" };
}
