export interface RateLimiter {
  /** ¿Hay presupuesto para consumir `cost` tokens de la llave `key` ahora
   *  mismo? Si es `true`, ya se descontaron. */
  tryConsume(key: string, cost?: number): boolean;
}

/**
 * Cubeta de tokens por llave (p. ej. por destinatario o por organización):
 * cada llave tiene su propio presupuesto que se rellena con el tiempo, así
 * un pico de correos a una persona no consume el presupuesto de las demás.
 */
export class TokenBucketRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    if (capacity <= 0 || !Number.isFinite(capacity)) throw new Error("capacity debe ser un número positivo.");
    if (refillPerSecond <= 0 || !Number.isFinite(refillPerSecond)) throw new Error("refillPerSecond debe ser un número positivo.");
  }

  tryConsume(key: string, cost = 1): boolean {
    const nowMs = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, lastRefillMs: nowMs };
    const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    const refilled = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillPerSecond);

    if (refilled < cost) {
      this.buckets.set(key, { tokens: refilled, lastRefillMs: nowMs });
      return false;
    }
    this.buckets.set(key, { tokens: refilled - cost, lastRefillMs: nowMs });
    return true;
  }
}

/** Un limitador que siempre permite — el default de `MailService` cuando no
 *  se configura ninguno explícitamente. */
export class UnlimitedRateLimiter implements RateLimiter {
  tryConsume(_key: string, _cost?: number): boolean {
    return true;
  }
}
