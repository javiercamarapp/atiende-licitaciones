import fs from "node:fs";

/**
 * Lector de la BANDEJA DE CAPTURA de `apps/api` para la suite E2E.
 *
 * No es una invención de esta suite ni un endpoint de pruebas añadido al
 * producto: `MAIL_CAPTURE_FILE` es una variable de entorno REAL y
 * documentada de la API ("Ruta JSONL donde el `CaptureProvider` también
 * deja cada correo, para inspeccionarlo fuera del proceso" —
 * apps/api/README.md § Variables de entorno, y packages/mail/README.md).
 * Sin `MAIL_PROVIDER`, `apps/api` degrada a `CaptureProvider`, que escribe
 * una línea JSON por correo renderizado y NUNCA sale a la red
 * (packages/mail/src/provider/capture-provider.ts).
 *
 * Es lo que hace posible ejercitar de verdad la compuerta de verificación
 * de correo (`REQUIRE_EMAIL_VERIFICATION=true`) en `test:e2e:full`: hasta
 * la ronda 8a la suite la apagaba porque no tenía forma honesta de leer el
 * enlace que ella misma provocaba (ver apps/web/README.md, ronda 8a,
 * bloqueo 2).
 *
 * LÍMITE REAL, declarado: `apps/api` NO expone ningún endpoint HTTP para
 * leer los correos capturados (se revisó `src/modules/` ruta por ruta). Por
 * eso este helper lee el ARCHIVO, lo que solo funciona cuando la suite
 * corre en la misma máquina que la API — que es exactamente el caso de
 * `test:e2e:full` (scripts/e2e-full.mjs arranca la API como proceso hijo).
 * Contra una API remota, estos specs se saltan solos.
 */

export interface CapturedEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
  capturedAt: string;
}

/** Ruta del JSONL de captura, o `null` si esta corrida no la configuró. */
export function mailCaptureFile(): string | null {
  return process.env.E2E_MAIL_CAPTURE_FILE ?? null;
}

function readAll(filePath: string): CapturedEmail[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    // Todavía no se ha capturado ningún correo: el archivo no existe.
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CapturedEmail);
}

/**
 * Espera al ÚLTIMO correo dirigido a `email` cuyo cuerpo contenga un enlace
 * hacia `path`, y devuelve ese enlace.
 *
 * Hay que esperar porque los envíos de registro/invitación/contacto salen
 * SIN `await` en la API (`fireAndForgetMail`, antienumeración por latencia):
 * cuando la petición HTTP responde, el correo todavía puede no estar
 * escrito.
 *
 * El enlace se extrae de la parte de TEXTO PLANO, no del HTML: en el HTML
 * el separador de query viaja escapado (`&amp;`) y reconstruirlo a mano
 * sería inventar un enlace que nadie recibió.
 */
export async function waitForMailLink(
  email: string,
  path: string,
  options: { timeoutMs?: number; after?: number } = {},
): Promise<string> {
  const filePath = mailCaptureFile();
  if (!filePath) throw new Error("E2E_MAIL_CAPTURE_FILE no está configurada: esta prueba no debería haber corrido.");

  const timeoutMs = options.timeoutMs ?? 15_000;
  const after = options.after ?? 0;
  const deadline = Date.now() + timeoutMs;
  const pattern = new RegExp(`https?://[^\\s"'<>]*${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s"'<>]*`);

  let vistos = 0;
  while (Date.now() < deadline) {
    const todos = readAll(filePath);
    vistos = todos.length;
    const candidatos = todos
      .slice(after)
      .filter((mail) => mail.to.includes(email))
      .map((mail) => mail.text.match(pattern)?.[0])
      .filter((url): url is string => Boolean(url));
    if (candidatos.length > 0) return candidatos[candidatos.length - 1];
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `No apareció ningún correo para ${email} con un enlace a ${path} en ${timeoutMs}ms (${vistos} correos capturados en total).`,
  );
}

/** Cuántos correos hay capturados AHORA — para pedir "el siguiente" y no uno viejo. */
export function capturedMailCount(): number {
  const filePath = mailCaptureFile();
  if (!filePath) return 0;
  return readAll(filePath).length;
}

/** TODOS los correos capturados hasta ahora, en orden de envío. */
export function capturedMails(): CapturedEmail[] {
  const filePath = mailCaptureFile();
  if (!filePath) return [];
  return readAll(filePath);
}

/** Los correos capturados hasta ahora dirigidos a una dirección concreta. */
export function capturedMailsTo(email: string): CapturedEmail[] {
  const filePath = mailCaptureFile();
  if (!filePath) return [];
  return readAll(filePath).filter((mail) => mail.to.includes(email));
}
