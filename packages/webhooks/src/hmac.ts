/**
 * REQ-096: núcleo de verificación de firma HMAC compartido por CUALQUIER
 * webhook entrante — antes de este paquete, esta lógica (calcular el HMAC
 * esperado, decodificarlo, comparar en tiempo constante contra uno o varios
 * candidatos) vivía duplicada solo dentro de `@atiende/mail`
 * (`webhooks/verify-signature.ts`, específico del esquema Svix de
 * Resend). Un webhook nuevo con OTRO esquema de firma (p. ej. el header
 * único `sha256=<hex>` de GitHub/Stripe-style, en vez del `svix-signature`
 * con varias firmas separadas por espacio) puede reutilizar directamente
 * esta función: solo cambia CÓMO se arma `signedContent` y CÓMO se separan
 * los candidatos del header — nunca la comparación criptográfica en sí,
 * que es la parte fácil de hacer mal (comparar con `===` filtra tiempo,
 * comparar el string base64/hex crudo en vez de los bytes decodificados
 * puede aceptar codificaciones distintas del mismo valor, etc.).
 *
 * Esta función NO conoce nada de proveedores, cabeceras HTTP ni tolerancia
 * de tiempo — ver `verify.ts` para la composición completa (firma +
 * ventana de tiempo + anti-replay) que sí expone esos conceptos.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type HmacEncoding = "hex" | "base64";

/** Calcula el HMAC-SHA256 de `content` con `secret`, en la codificación pedida. */
export function computeHmacDigest(content: string, secret: Buffer, encoding: HmacEncoding): string {
  return createHmac("sha256", secret).update(content).digest(encoding);
}

/**
 * `true` si ALGUNO de `candidates` (valores ya extraídos del header de
 * firma, en la misma `encoding` que el digest esperado — p. ej. las
 * cadenas base64 sueltas tras separar `svix-signature` por espacio, o el
 * texto hex tras el prefijo `sha256=`) coincide, en tiempo constante, con
 * el HMAC-SHA256 esperado de `content` bajo `secret`.
 *
 * Basta con que UNA firma coincida — necesario para soportar rotación de
 * secreto (un proveedor puede mandar la firma vieja y la nueva a la vez
 * mientras el secreto rota).
 */
export function matchesAnyHmacSignature(
  content: string,
  candidates: readonly string[],
  secret: Buffer,
  encoding: HmacEncoding,
): boolean {
  if (secret.length === 0) return false;
  const expected = computeHmacDigest(content, secret, encoding);
  const expectedBuf = Buffer.from(expected, encoding);

  return candidates.some((candidate) => {
    let candidateBuf: Buffer;
    try {
      candidateBuf = Buffer.from(candidate, encoding);
    } catch {
      return false;
    }
    // Buffers de distinta longitud: timingSafeEqual lanzaría en vez de
    // devolver false, así que se filtra antes. La longitud en sí no es un
    // secreto (el atacante ya conoce el tamaño de un HMAC-SHA256).
    return candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf);
  });
}
