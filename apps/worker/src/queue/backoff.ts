export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  /** Fracción máxima de jitter aleatorio aplicada sobre el delay calculado (0.2 = ±20%). */
  jitterRatio?: number;
  random?: () => number;
}

const DEFAULTS: Required<BackoffOptions> = {
  baseMs: 1000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitterRatio: 0.2,
  random: Math.random,
};

/**
 * Backoff exponencial con jitter completo (REQ-077/REQ-016). `attempt` es el
 * número de intento que ACABA de fallar (1 = primer intento falló). El
 * jitter es multiplicativo y simétrico alrededor del delay "puro" para que
 * el valor esperado no se desplace sistemáticamente hacia arriba o abajo.
 */
export function computeBackoffDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const opts = { ...DEFAULTS, ...options };
  const pure = Math.min(opts.maxMs, opts.baseMs * Math.pow(opts.factor, Math.max(0, attempt - 1)));
  const jitterSpan = pure * opts.jitterRatio;
  const jitter = (opts.random() * 2 - 1) * jitterSpan;
  return Math.max(0, Math.round(pure + jitter));
}
