import type { HmacWebhookScheme, ParsedWebhookHeaders } from './hmac-webhook-guard.js';

/**
 * REQ-096: adaptador del esquema de firma Svix para `createHmacWebhookGuard`
 * — el MISMO esquema que ya usa `@atiende/mail` (`verifyResendWebhookSignature`)
 * para `POST /webhooks/mail/:provider`, expuesto aquí como
 * `HmacWebhookScheme` genérico para que un webhook NUEVO que también firme
 * con Svix (es infraestructura de webhooks usada por varios proveedores,
 * no solo Resend) no tenga que reimplementarlo.
 *
 * No reemplaza el verificador de `@atiende/mail` (ese sigue siendo la
 * implementación real de `POST /webhooks/mail/:provider`, ya en
 * producción) — ver `test/lib/webhooks/svix-scheme.test.ts`, que prueba
 * que ambos producen el MISMO resultado ante las mismas cabeceras, cuerpo
 * y secreto, como evidencia de que esta generalización es fiel al
 * comportamiento real que ya se usa.
 */
export function createSvixScheme(): HmacWebhookScheme {
  return {
    encoding: 'base64',
    parseHeaders(headers): ParsedWebhookHeaders | null {
      const svixId = headerValue(headers['svix-id']);
      const svixTimestampRaw = headerValue(headers['svix-timestamp']);
      const svixSignature = headerValue(headers['svix-signature']);
      if (!svixId || !svixTimestampRaw || !svixSignature) return null;

      const timestampSeconds = Number(svixTimestampRaw);
      if (!Number.isFinite(timestampSeconds)) return null;

      const signatureCandidates = svixSignature
        .split(' ')
        .map((part) => part.split(',')[1])
        .filter((v): v is string => Boolean(v));

      return { eventId: svixId, timestampSeconds, signatureCandidates };
    },
    buildSignedContent(rawBody, eventId, timestampSeconds) {
      return `${eventId}.${timestampSeconds}.${rawBody}`;
    },
    decodeSecret(secret) {
      const base64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
      let bytes: Buffer;
      try {
        bytes = Buffer.from(base64, 'base64');
      } catch {
        return null;
      }
      return bytes.length > 0 ? bytes : null;
    },
  };
}

function headerValue(raw: string | string[] | undefined): string {
  return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
}
