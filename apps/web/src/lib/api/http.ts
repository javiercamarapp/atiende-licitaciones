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

const MAX_RATE_LIMIT_RETRIES = 2;

/**
 * Petición cruda a apps/api: no inyecta autenticación ni X-Org-Id (eso lo
 * hace `apiRequest` en `client.ts`). Usada directamente solo por rutas
 * públicas (login, refresh) y por `client.ts` para el reintento tras 401.
 *
 * Reintento de 429 (`@fastify/rate-limit`, ver apps/api/src/app.ts: 100/min
 * global por IP + 5/min específico en /auth/login): un límite de tasa es,
 * por definición, transitorio — respeta `Retry-After` si la API lo manda
 * (siempre lo hace) y reintenta hasta 2 veces antes de rendirse con el
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
    const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 500;
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
