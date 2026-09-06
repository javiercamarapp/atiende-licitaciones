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
  /**
   * Ronda 5 (REQ-044/064): token de una sesión de step-up vigente (`POST
   * /auth/2fa/step-up`), exigido por apps/api en `X-Step-Up` antes de
   * aprobar una tarifa o un expediente. Ausente/omitido en cualquier otra
   * ruta.
   */
  stepUpToken?: string;
}

function buildHeaders(opts: ApiRequestOptions, accessToken: string | null): Record<string, string> {
  // Solo se declara `Content-Type: application/json` cuando de verdad hay
  // un cuerpo: varias mutaciones de apps/api son POST sin body (p. ej.
  // `POST /company/rates/:id/approve`, `.../reject`, `/agents/tool-calls/:id/approve|deny`,
  // `/admin/jobs/:id/retry`, `/admin/incidents/:id/resolve`) y Fastify
  // rechaza con 400 ("Body cannot be empty when content-type is set to
  // 'application/json'") una petición que declara ese Content-Type sin
  // enviar ningún cuerpo — encontrado real en la suite E2E contra apps/api
  // real (ver docs/logs/web-ronda3.log), no algo que MSW en pruebas
  // unitarias hubiera detectado (no reproduce ese comportamiento estricto).
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (!opts.skipAuth) {
    if (!accessToken) {
      throw new ApiError("No hay una sesión activa. Inicia sesión de nuevo.", 401);
    }
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (opts.orgId) headers["X-Org-Id"] = opts.orgId;
  if (opts.stepUpToken) headers["X-Step-Up"] = opts.stepUpToken;
  return headers;
}

// Evita disparar N refresh en paralelo cuando varias queries reciben 401 al
// mismo tiempo (p. ej. al volver de background con el access token vencido):
// todas esperan la misma promesa de refresh en curso.
//
// RF-02 (docs/auditoria-2/ronda5-final.md, MEDIA): este mutex de módulo
// SOLO protege a quien pase por `refreshSessionOnce()` (ver abajo) -- antes
// de esta corrección, `AuthProvider.bootstrap()` llamaba a la función de
// refresh de abajo DIRECTO, sin pasar por aquí. `refresh_tokens` es de un
// solo uso con rotación real (apps/api): dos llamadas casi simultáneas al
// refresh REAL (una del bootstrap, otra de un 401-retry concurrente de
// `apiRequest`) con el MISMO refresh token producían un 200 para la
// primera y un 401 para la segunda -- y el `catch` de la llamada perdedora
// (`clearTokens()`) borraba el token recién rotado por la ganadora,
// deslogueando a un usuario con una sesión perfectamente válida.
// Reproducido en vivo, intermitente, tanto en `vite dev` como en el build
// de producción real servido con `vite preview` (no es un artefacto de
// React StrictMode). Nota: este mutex vive en memoria de MÓDULO -- no
// protege el caso multi-pestaña (cada pestaña tiene el suyo); eso exigiría
// además un lock cross-tab (p. ej. Web Locks API), fuera del alcance de
// esta corrección puntual.
let refreshInFlight: Promise<void> | null = null;

/** Ejecuta la rotación REAL de refresh token contra apps/api y guarda los tokens nuevos. Uso interno -- fuera de este módulo, usar SIEMPRE `refreshSessionOnce()`. */
async function refreshSession(): Promise<void> {
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
 * RF-02: único punto de entrada externo para refrescar la sesión -- reusa
 * la promesa de refresh YA en curso si existe, en vez de disparar una
 * nueva. Usado por AMBOS sitios que necesitan restaurar/renovar la sesión:
 * el reintento automático tras un 401 dentro de `apiRequest` (abajo) y
 * `AuthProvider.bootstrap()` (src/hooks/useAuth.tsx), que la llama para
 * restaurar una sesión desde el refresh token persistido en localStorage al
 * recargar la pestaña. Si ambos disparan "casi" al mismo tiempo, el
 * segundo espera la MISMA promesa del primero en vez de pedir su propio
 * refresh -- nunca hay dos POST /auth/refresh concurrentes con el mismo
 * token de un solo uso.
 */
export function refreshSessionOnce(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = refreshSession().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
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
      await refreshSessionOnce();
    } catch {
      clearTokens();
      throw err;
    }

    const { accessToken: refreshedToken } = getTokens();
    const retryHeaders = buildHeaders(opts, refreshedToken);
    return rawRequest<T>(path, { ...init, headers: retryHeaders });
  }
}
