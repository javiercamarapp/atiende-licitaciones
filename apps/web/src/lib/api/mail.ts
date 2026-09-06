import { z } from "zod";

import { rawRequest } from "./http";
import { apiRequest } from "./client";

/**
 * REQ-181..196 (ronda 8b): cliente de los flujos de correo de cuenta de
 * `apps/api` — verificación de correo, recuperación de contraseña,
 * preferencias de notificación y baja de un clic (RFC 8058).
 *
 * Dos decisiones transversales que valen la pena decir una sola vez:
 *
 * 1. **`retries = 0` en las cuatro rutas que dispara una PERSONA a mano**
 *    (`/auth/password/forgot`, `/auth/email/resend-verification`, y ver
 *    `public.ts` para `POST /public/contact`). `rawRequest` reintenta un 429
 *    hasta 6 veces con backoff (ver `http.ts`), lo correcto para una ráfaga
 *    de lecturas de arranque de sesión; aquí sería justo lo contrario: el
 *    límite de tasa del tier `auth` (5/min por IP, el más estricto de la
 *    API) es lo que impide usar estos endpoints para mandar correo a
 *    terceros en volumen, así que un 429 es una respuesta REAL que el
 *    usuario debe ver ("espera un minuto"), no un contratiempo que el
 *    cliente deba absorber mandando el correo de todas formas 20 segundos
 *    después. Las rutas que NO dispara una persona repetidamente
 *    (`/auth/email/verify`, `/auth/password/reset`, ambas una sola vez al
 *    abrir el enlace del correo) conservan el reintento por defecto.
 *
 * 2. **Los enlaces firmados viajan tal cual llegaron.** `d` (payload
 *    base64url) y `s` (firma HMAC) se reenvían a la API sin interpretarlos
 *    ni reconstruirlos: esta capa no sabe —ni debe saber— qué hay dentro.
 *    Quien decide es el servidor (firma + consumo atómico del token, ver
 *    apps/api/src/modules/auth/mail.routes.ts).
 */

/** Los dos parámetros que lleva TODO enlace firmado de un correo (`?d=…&s=…`). */
export interface SignedLinkParams {
  d: string;
  s: string;
}

/**
 * Extrae `d`/`s` de la query de una pantalla que aterriza desde un correo.
 * Devuelve `null` si falta cualquiera de los dos — un enlace truncado (un
 * cliente de correo que corta la URL, un copiar/pegar a medias) se trata
 * exactamente igual que uno inválido: la pantalla ofrece pedir uno nuevo,
 * nunca manda a la API una petición que ya se sabe incompleta.
 */
export function readSignedLinkParams(search: string | URLSearchParams): SignedLinkParams | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const d = params.get("d");
  const s = params.get("s");
  if (!d || !s) return null;
  return { d, s };
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

// ---------------------------------------------------------------------
// Verificación de correo
// ---------------------------------------------------------------------

const verifiedSchema = z.object({ verified: z.literal(true) });

/** `POST /auth/email/verify` — consume el token del enlace (un solo uso real en la base). */
export async function verifyEmail(params: SignedLinkParams): Promise<void> {
  verifiedSchema.parse(await rawRequest<unknown>("/auth/email/verify", jsonPost(params)));
}

/**
 * `POST /auth/email/resend-verification` — responde 202 con el MISMO cuerpo
 * exista o no la cuenta (antienumeración deliberada de `apps/api`), así que
 * esta función no puede devolver "se mandó" / "no se mandó": no existe esa
 * información del lado del cliente y fingirla sería mentir.
 */
export async function resendEmailVerification(email: string): Promise<void> {
  await rawRequest<unknown>("/auth/email/resend-verification", jsonPost({ email }), 0);
}

// ---------------------------------------------------------------------
// Recuperación de contraseña
// ---------------------------------------------------------------------

/** `POST /auth/password/forgot` — 202 idéntico exista o no el correo (ver arriba). */
export async function requestPasswordReset(email: string): Promise<void> {
  await rawRequest<unknown>("/auth/password/forgot", jsonPost({ email }), 0);
}

/** `POST /auth/password/reset` — cambia la contraseña y revoca TODAS las sesiones (lo hace la API en la misma transacción). */
export async function resetPassword(params: SignedLinkParams & { newPassword: string }): Promise<void> {
  await rawRequest<unknown>("/auth/password/reset", jsonPost(params));
}

// ---------------------------------------------------------------------
// Preferencias de notificación (con sesión)
// ---------------------------------------------------------------------

/** Espejo EXACTO de `preferencesSchema` (apps/api/src/modules/mail/routes.ts). */
export const notificationPreferencesSchema = z.object({
  tenderMatches: z.boolean(),
  tenderChanges: z.boolean(),
  approvals: z.boolean(),
  submission: z.boolean(),
  deadlines: z.boolean(),
  documentExpiration: z.boolean(),
  postAward: z.boolean(),
  weeklySummary: z.boolean(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export async function getNotificationPreferences(): Promise<NotificationPreferences> {
  return notificationPreferencesSchema.parse(await apiRequest<unknown>("/mail/preferences"));
}

/**
 * `PUT /mail/preferences` acepta un subconjunto (las categorías omitidas se
 * dejan como estaban) y devuelve el estado COMPLETO ya persistido — que es
 * lo que se pinta, nunca el optimista del cliente.
 */
export async function updateNotificationPreferences(patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
  return notificationPreferencesSchema.parse(await apiRequest<unknown>("/mail/preferences", { method: "PUT", body: patch }));
}

// ---------------------------------------------------------------------
// Baja de un clic (RFC 8058) — sin sesión, la identidad sale del enlace
// ---------------------------------------------------------------------

const unsubscribeLinkStatusSchema = z.object({ valid: z.literal(true), category: z.string().nullable() });
export type UnsubscribeLinkStatus = z.infer<typeof unsubscribeLinkStatusSchema>;

/**
 * `GET /mail/unsubscribe` — SOLO valida el enlace y dice qué categoría
 * apagaría (`null` = todas las opcionales). No aplica nada: la API separa
 * a propósito la validación (GET, idempotente, la que dispara un escáner de
 * enlaces del proveedor de correo) de la baja real (POST).
 */
export async function checkUnsubscribeLink(params: SignedLinkParams): Promise<UnsubscribeLinkStatus> {
  const query = new URLSearchParams({ d: params.d, s: params.s }).toString();
  return unsubscribeLinkStatusSchema.parse(await rawRequest<unknown>(`/mail/unsubscribe?${query}`));
}

/** `POST /mail/unsubscribe` — aplica la baja. Anónimo: el `userId` sale de la firma del enlace. */
export async function applyUnsubscribe(params: SignedLinkParams): Promise<void> {
  const query = new URLSearchParams({ d: params.d, s: params.s }).toString();
  await rawRequest<unknown>(`/mail/unsubscribe?${query}`, { method: "POST" });
}
