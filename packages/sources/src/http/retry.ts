/**
 * Parsea el encabezado `Retry-After` (segundos u fecha HTTP) a milisegundos
 * de espera desde `nowMs`. Devuelve `undefined` si el encabezado falta o es
 * inválido.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs: number): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Math.max(0, seconds * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return undefined;
}

export interface BackoffOptions {
  attempt: number; // 0-based: intento que falló
  baseDelayMs: number;
  maxDelayMs: number;
  /** función de aleatoriedad inyectable en [0,1) para jitter determinista en tests */
  random?: () => number;
}

/**
 * Backoff exponencial con jitter completo ("full jitter"): delay = random()
 * * min(maxDelayMs, baseDelayMs * 2^attempt). Determinista si se inyecta
 * `random`.
 */
export function computeBackoffDelayMs(options: BackoffOptions): number {
  const { attempt, baseDelayMs, maxDelayMs, random = Math.random } = options;
  const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(random() * capped);
}

/** Códigos de estado HTTP ante los que se reintenta (429 y 5xx). */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}
