export interface RetryPolicy {
  /** Intentos totales, incluido el primero. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Proporción de jitter aleatorio (±) sobre el retraso exponencial. */
  jitterRatio?: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
};

/**
 * Backoff exponencial con jitter: `attempt` es 1-based (el primer reintento,
 * después del intento 1 fallido, es `attempt = 1`). El jitter evita que
 * varios envíos fallidos al mismo tiempo reintenten todos en el mismo
 * instante ("thundering herd").
 */
export function computeBackoffDelay(attempt: number, policy: RetryPolicy, random: () => number = Math.random): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitterRatio = policy.jitterRatio ?? 0;
  const jitter = exponential * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(exponential + jitter));
}
