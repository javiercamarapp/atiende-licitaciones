// E21 (docs/BACKLOG.md): sesiones activas de la propia cuenta (una fila por
// refresh token vigente, ver apps/api/src/modules/auth/sessions.routes.ts).
// Módulo separado de `./session.ts` (que guarda LOS TOKENS de ESTA pestaña
// en localStorage) a propósito -- dominios distintos que comparten un
// nombre parecido: este archivo habla con `GET/DELETE /auth/sessions` y
// `POST /auth/sessions/revoke-others`, ninguno de los cuales toca el
// almacenamiento local.
import { apiRequest } from "./client";
import {
  authSessionsListSchema,
  revokeSessionResponseSchema,
  revokeOtherSessionsResponseSchema,
  type AuthSessionsList,
  type RevokeSessionResponse,
  type RevokeOtherSessionsResponse,
} from "./schemas";

/** Ninguna de las tres rutas de este módulo exige `X-Org-Id` -- son endpoints de USUARIO (sin `app.requireOrg`), igual que `/auth/2fa/status`. */
export async function listAuthSessions(): Promise<AuthSessionsList> {
  const raw = await apiRequest<unknown>("/auth/sessions");
  return authSessionsListSchema.parse(raw);
}

/**
 * `DELETE /auth/sessions/:id`: cierra esa sesión concreta. Si resulta ser
 * la sesión que la propia pestaña está usando ahora mismo, el próximo
 * intento de refrescar el access token fallará (401) y la app redirige a
 * `/login` por el flujo normal de expiración -- no hay forma de que el
 * cliente sepa de antemano cuál fila de la lista es "esta" sesión (el id
 * de fila no viaja de vuelta en `/auth/login`/`/auth/refresh`), así que la
 * UI no intenta distinguirla.
 */
export async function revokeAuthSession(id: string): Promise<RevokeSessionResponse> {
  const raw = await apiRequest<unknown>(`/auth/sessions/${id}`, { method: "DELETE" });
  return revokeSessionResponseSchema.parse(raw);
}

/**
 * `POST /auth/sessions/revoke-others`: cierra todas las sesiones EXCEPTO
 * la que corresponde a `refreshToken` (el de esta misma pestaña, ver
 * `getTokens()` en `./session.ts`) -- apps/api exige que ese token
 * corresponda a una sesión vigente propia antes de revocar cualquier otra.
 */
export async function revokeOtherAuthSessions(refreshToken: string): Promise<RevokeOtherSessionsResponse> {
  const raw = await apiRequest<unknown>("/auth/sessions/revoke-others", { method: "POST", body: { refreshToken } });
  return revokeOtherSessionsResponseSchema.parse(raw);
}
