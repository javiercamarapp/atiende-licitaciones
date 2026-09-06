import { ApiError, rawRequest } from "./http";
import { clearTokens, getTokens, setTokens } from "./session";
import { authTokensSchema } from "./schemas";

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Organización actual (X-Org-Id). Omitir en rutas que no operan sobre una organización. */
  orgId?: string | null;
  /** Rutas públicas (login/registro/refresh): no exige access token. */
  skipAuth?: boolean;
}

function buildHeaders(opts: ApiRequestOptions, accessToken: string | null): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!opts.skipAuth) {
    if (!accessToken) {
      throw new ApiError("No hay una sesión activa. Inicia sesión de nuevo.", 401);
    }
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (opts.orgId) headers["X-Org-Id"] = opts.orgId;
  return headers;
}

// Evita disparar N refresh en paralelo cuando varias queries reciben 401 al
// mismo tiempo (p. ej. al volver de background con el access token vencido):
// todas esperan la misma promesa de refresh en curso.
let refreshInFlight: Promise<void> | null = null;

/**
 * Ejecuta la rotación de refresh token contra apps/api y guarda los tokens
 * nuevos. Exportada además de usarse internamente en `apiRequest`: el
 * arranque de sesión (`AuthProvider`, ver src/hooks/useAuth.tsx) la llama
 * directamente para restaurar una sesión desde el refresh token persistido
 * en localStorage al recargar la pestaña.
 */
export async function refreshSession(): Promise<void> {
  const { refreshToken } = getTokens();
  if (!refreshToken) {
    throw new ApiError("La sesión expiró. Inicia sesión de nuevo.", 401);
  }
  const raw = await rawRequest<unknown>("/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  const parsed = authTokensSchema.parse(raw);
  setTokens(parsed);
}

/**
 * Petición autenticada hacia apps/api con reintento automático de UNA vez
 * tras un 401 (access token vencido): refresca con el refresh token
 * (rotación real del lado del servidor, ver apps/api/src/modules/auth/routes.ts)
 * y reintenta la petición original con el access token nuevo. Si el refresh
 * mismo falla (refresh token vencido/revocado/ausente), limpia la sesión y
 * deja que el 401 original se propague para que la UI redirija a /login.
 */
export async function apiRequest<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  const { accessToken } = getTokens();
  const headers = buildHeaders(opts, accessToken);
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  try {
    return await rawRequest<T>(path, init);
  } catch (err) {
    const isAuthExpiry = err instanceof ApiError && err.status === 401 && !opts.skipAuth;
    if (!isAuthExpiry) throw err;

    try {
      if (!refreshInFlight) {
        refreshInFlight = refreshSession().finally(() => {
          refreshInFlight = null;
        });
      }
      await refreshInFlight;
    } catch {
      clearTokens();
      throw err;
    }

    const { accessToken: refreshedToken } = getTokens();
    const retryHeaders = buildHeaders(opts, refreshedToken);
    return rawRequest<T>(path, { ...init, headers: retryHeaders });
  }
}
