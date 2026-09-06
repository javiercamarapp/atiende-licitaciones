import type { FastifyInstance } from 'fastify';
import type { SignedLinkPayload } from '@atiende/mail';

/**
 * REQ-181..195: los enlaces de correo (verificación, invitación,
 * restablecimiento, baja) se firman con HMAC contra la URL PÚBLICA de
 * `apps/web` (`config.publicUrl`), no contra la de esta API: quien recibe
 * el correo abre una pantalla del producto, no un endpoint JSON. Esa
 * pantalla reenvía a esta API los dos parámetros del enlace (`d` = payload
 * en base64url, `s` = firma) tal cual los recibió.
 *
 * Este helper es el ÚNICO lugar donde se reconstruye la URL firmada para
 * verificarla: `createLinkSigner` firma sobre `d` únicamente (ver
 * packages/mail/src/security/signed-link.ts), así que el `path` que se pase
 * aquí no participa en la firma -- se conserva por claridad y para que el
 * `URL` resultante sea el mismo que se emitió, nunca como control de
 * seguridad. Lo que SÍ garantiza la firma es que el payload (`d`) no fue
 * manipulado y que no ha expirado.
 *
 * Devuelve `null` ante cualquier fallo (firma inválida, expirado,
 * malformado) -- deliberadamente SIN distinguir el motivo hacia afuera: un
 * "token expirado" contra "firma inválida" le diría a quien prueba enlaces
 * al azar cuándo acertó el formato. El llamador responde un único mensaje
 * genérico.
 */
export function verifySignedMailParams<T extends SignedLinkPayload = SignedLinkPayload>(
  app: FastifyInstance,
  path: string,
  params: { d: string; s: string }
): (T & { exp: number }) | null {
  const url = new URL(path, app.config.publicUrl);
  url.searchParams.set('d', params.d);
  url.searchParams.set('s', params.s);
  const result = app.mail.verifySignedLink<T>(url.toString());
  return result.ok ? (result.payload as T & { exp: number }) : null;
}

/** Días que vive un enlace de baja de un clic dentro de un correo. Largo a
 *  propósito: alguien puede darse de baja desde un correo de hace semanas y
 *  RFC 8058 exige que ese botón siga funcionando -- no es una credencial de
 *  acceso, solo apaga notificaciones de ESE usuario. */
const UNSUBSCRIBE_TTL_SECONDS = 180 * 24 * 60 * 60;

/**
 * URL de baja de un clic (RFC 8058) para un usuario y, opcionalmente, una
 * sola categoría. Sin `category`, apaga TODAS las categorías opcionales
 * (nunca las obligatorias de seguridad de cuenta: esas ni siquiera llevan
 * `unsubscribeUrl`, ver `buildListUnsubscribeHeaders` de packages/mail).
 */
export function buildUnsubscribeUrl(app: FastifyInstance, userId: string, category?: string): string {
  const payload: SignedLinkPayload = { userId, category: category ?? null };
  return app.mail.signedLink(app.config.publicUrl, '/preferencias/baja', payload, UNSUBSCRIBE_TTL_SECONDS);
}

/** Pantalla de preferencias de notificación de `apps/web` (enlace del pie de todo correo opcional). */
export function buildPreferencesUrl(app: FastifyInstance): string {
  return new URL('/preferencias', app.config.publicUrl).toString();
}
