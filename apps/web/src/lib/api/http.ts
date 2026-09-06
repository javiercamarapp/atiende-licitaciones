// Capa HTTP de más bajo nivel hacia apps/api. Todas las respuestas de error
// de la API son `application/problem+json` (RFC 7807): { type, title,
// status, detail?, requestId }. `ApiError` conserva ese `requestId` para que
// la UI lo muestre siempre que haya un error real (REQ del back office:
// "request_id visible"), en vez de un mensaje genérico.
const API_URL = import.meta.env.VITE_API_URL ?? "";

export class ApiError extends Error {
  status?: number;
  requestId?: string;
  type?: string;
  detail?: unknown;

  constructor(message: string, status?: number, extra?: { requestId?: string; type?: string; detail?: unknown }) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.requestId = extra?.requestId;
    this.type = extra?.type;
    this.detail = extra?.detail;
  }
}

/**
 * Guard 404 de tenant cruzado (ver src/pages/ResourceNotFoundPage.tsx): un
 * recurso de OTRA organización responde 403 o 404 real desde apps/api según
 * la ruta (RLS/`app.requireOrg` según el caso) — para la UI, ambos casos
 * deben tratarse igual: un recurso no accesible desde la sesión actual,
 * nunca revelado como "existe pero no es tuyo".
 */
export function isNotFoundOrForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.status === 404);
}

/**
 * Ronda 8b: un 429 de `apps/api` NO trae un mensaje presentable. El límite
 * lo aplica `@fastify/rate-limit` (nunca un `AppError` propio), así que el
 * manejador de errores de la API cae en su rama genérica y el `title` que
 * llega es el literal en inglés del plugin ("Rate limit exceeded, retry in
 * 1 minute") — verificado en apps/api/src/plugins/error-handler.ts. Las
 * pantallas que disparan las rutas del tier `auth` (recuperación,
 * reenvío de verificación, contacto público) lo detectan con esto y
 * escriben su propio mensaje honesto en español, en vez de mostrarle al
 * usuario el texto interno de una dependencia.
 */
export function isRateLimited(err: unknown): boolean {
  return err instanceof ApiError && err.status === 429;
}

interface ProblemJson {
  type?: string;
  title?: string;
  status?: number;
  detail?: unknown;
  requestId?: string;
}

async function toApiError(response: Response): Promise<ApiError> {
  let problem: ProblemJson | null = null;
  try {
    problem = (await response.json()) as ProblemJson;
  } catch {
    // El cuerpo no era JSON (o estaba vacío) — se conserva statusText.
  }
  const message = problem?.title || response.statusText || `Error ${response.status}`;
  return new ApiError(message, response.status, {
    requestId: problem?.requestId,
    type: problem?.type,
    detail: problem?.detail,
  });
}

// 6 reintentos (no 2): verificado en la suite E2E real (test:e2e:full)
// contra apps/api real que, bajo ráfagas sostenidas (p. ej. recorrer las 24
// rutas del sidebar seguidas, cada una con 3-4 peticiones de arranque de
// sesión), el límite global de 100/min puede tardar más de 1-2 reintentos
// cortos en despejarse — un cliente HTTP robusto no debe rendirse ante un
// límite de tasa transitorio solo porque el primer par de reintentos
// coincidió con el pico.
const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_RATE_LIMIT_WAIT_MS = 4000;

/**
 * Petición cruda a apps/api: no inyecta autenticación ni X-Org-Id (eso lo
 * hace `apiRequest` en `client.ts`). Usada directamente solo por rutas
 * públicas (login, refresh) y por `client.ts` para el reintento tras 401.
 *
 * Reintento de 429 (`@fastify/rate-limit`, ver apps/api/src/app.ts: 100/min
 * global por IP + 5/min específico en /auth/login): un límite de tasa es,
 * por definición, transitorio — respeta `Retry-After` si la API lo manda
 * (siempre lo hace) y reintenta varias veces antes de rendirse con el
 * `ApiError` real. Sin esto, un pico legítimo de tráfico (varias pestañas,
 * o la propia suite E2E recorriendo muchas rutas seguidas) se mostraría
 * como un error genérico en vez de resolverse solo, como haría cualquier
 * cliente HTTP robusto.
 */
export async function rawRequest<T>(path: string, init: RequestInit = {}, retriesLeft = MAX_RATE_LIMIT_RETRIES): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, init);
  } catch {
    throw new ApiError("No se pudo conectar con el servidor. Verifica tu conexión e inténtalo de nuevo.");
  }

  if (response.status === 429 && retriesLeft > 0) {
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const waitMs = Math.min(
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 500,
      MAX_RATE_LIMIT_WAIT_MS,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return rawRequest<T>(path, init, retriesLeft - 1);
  }

  if (!response.ok) {
    throw await toApiError(response);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}
