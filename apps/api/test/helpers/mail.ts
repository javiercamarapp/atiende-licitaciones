import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { CapturedEmail, CaptureProvider } from '@atiende/mail';

/**
 * REQ-181..195: utilidades compartidas por las pruebas de integración de
 * correo de `apps/api`.
 *
 * Sin `MAIL_PROVIDER` (ninguna suite la define, ver `test/helpers.ts`), el
 * `MailProvider` que arma `createMailProviderFromEnv` es el `CaptureProvider`
 * de packages/mail: guarda en memoria lo que HABRÍA mandado y nunca toca la
 * red. Esa es la única forma de probar de punta a punta el contenido real de
 * un correo (asunto, enlace firmado, cabeceras `List-Unsubscribe`) sin
 * credenciales de un proveedor real -- y también la garantía de la regla dura
 * "nunca enviar correo real sin proveedor configurado".
 */
export function mailCapture(app: FastifyInstance): CaptureProvider {
  const provider = app.mailProvider;
  expect(provider.name).toBe('capture');
  return provider as CaptureProvider;
}

/**
 * Espera a que terminen los envíos disparados sin `await` (registro,
 * contacto, reenvíos) y devuelve el ÚLTIMO correo capturado para esa
 * dirección. Determinista: nunca un `sleep` arbitrario -- ver
 * `lib/mail/pending.ts`.
 */
export async function lastMailTo(app: FastifyInstance, email: string): Promise<CapturedEmail> {
  await app.waitForPendingMail();
  const captured = mailCapture(app).findLastTo(email);
  if (!captured) {
    const todos = mailCapture(app)
      .list()
      .map((c) => `${c.to.join(',')} :: ${c.subject}`)
      .join(' | ');
    throw new Error(`No se capturó ningún correo para ${email}. Capturados: [${todos}]`);
  }
  return captured;
}

/** Todos los correos capturados hasta ahora (tras vaciar la cola de envíos en segundo plano). */
export async function allMail(app: FastifyInstance): Promise<CapturedEmail[]> {
  await app.waitForPendingMail();
  return mailCapture(app).list();
}

/**
 * Extrae del cuerpo de TEXTO de un correo el primer enlace absoluto cuya
 * ruta sea `path`, y devuelve sus parámetros firmados (`d`/`s`) tal como los
 * reenviaría `apps/web` a esta API. Se usa el texto plano (no el HTML) a
 * propósito: ahí las URL van sin escapar (`&`, no `&amp;`).
 */
export function signedParamsFrom(captured: CapturedEmail, path: string): { d: string; s: string } {
  const url = urlFrom(captured, path);
  const d = url.searchParams.get('d');
  const s = url.searchParams.get('s');
  if (!d || !s) throw new Error(`El enlace ${url.toString()} no trae d/s`);
  return { d, s };
}

export function urlFrom(captured: CapturedEmail, path: string): URL {
  const pattern = new RegExp(`https?://[^\\s"'<>\\)]*${escapeRegExp(path)}\\?[^\\s"'<>\\)]+`);
  const match = pattern.exec(captured.text ?? '') ?? pattern.exec(captured.html);
  if (!match) {
    throw new Error(`No se encontró un enlace a ${path} en el correo "${captured.subject}"`);
  }
  // El texto plano de React Email puede envolver la URL entre corchetes/paréntesis.
  return new URL(match[0].replace(/[\].,;]+$/, ''));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
