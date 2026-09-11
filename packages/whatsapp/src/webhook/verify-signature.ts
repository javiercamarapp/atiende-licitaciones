import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verificación de la firma de webhook de Meta (Cloud API de WhatsApp
 * Business) — esquema REAL y documentado de Meta, DISTINTO del de Svix que
 * usa `@atiende/mail` (ver `packages/mail/src/webhooks/verify-signature.ts`):
 *
 *   cabecera            = "X-Hub-Signature-256: sha256=<hex>"
 *   firma_esperada(hex) = HMAC-SHA256(cuerpo_crudo, app_secret_utf8)
 *
 * Diferencias reales frente al esquema Svix (no un descuido, así es la
 * plataforma de Meta):
 *  - La llave HMAC es el **App Secret** de la app de Meta tal cual (UTF-8),
 *    nunca base64-decodificado.
 *  - El contenido firmado es SOLO el cuerpo crudo — sin id ni timestamp
 *    concatenados (Meta no manda una cabecera de timestamp en este webhook).
 *  - La codificación de la firma es **hex**, no base64.
 *  - No hay ventana de tolerancia de reloj que verificar aquí: la
 *    deduplicación real la da el `wamid` (REQ-074, ver `./replay-guard.ts`),
 *    no un timestamp de la firma.
 *
 * El cuerpo debe ser el texto CRUDO recibido (antes de `JSON.parse`): un
 * solo espacio de diferencia en el re-serializado invalida la firma — mismo
 * motivo que en `@atiende/mail`.
 */
export type VerifyMetaWebhookSignatureResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "secreto_no_configurado"
        | "cabecera_ausente"
        | "cabecera_mal_formada"
        | "firma_invalida";
    };

const SIGNATURE_PREFIX = "sha256=";

export function verifyMetaWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  appSecret: string | undefined
): VerifyMetaWebhookSignatureResult {
  if (!appSecret) return { ok: false, reason: "secreto_no_configurado" };
  if (!signatureHeader) return { ok: false, reason: "cabecera_ausente" };
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: "cabecera_mal_formada" };

  const candidateHex = signatureHeader.slice(SIGNATURE_PREFIX.length).trim();
  if (candidateHex.length === 0 || !/^[0-9a-f]+$/i.test(candidateHex)) {
    return { ok: false, reason: "cabecera_mal_formada" };
  }

  const expectedHex = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  const candidateBuf = Buffer.from(candidateHex, "hex");
  const expectedBuf = Buffer.from(expectedHex, "hex");
  const matches = candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);

  return matches ? { ok: true } : { ok: false, reason: "firma_invalida" };
}
