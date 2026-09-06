import { InvalidAmountError } from "./errors.js";
import type { OrganizationId } from "./types.js";

/**
 * Rate limiter tipo token-bucket por organización (REQ-079 aplica el
 * concepto a scraping; aquí se generaliza para limitar tool_calls/LLM por
 * tenant). Cada bucket se rellena de forma continua según
 * `refillTokensPerSecond`, hasta `capacity`. `now` es inyectable para
 * pruebas deterministas.
 */
export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; lastRefillMs: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillTokensPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  private key(organizationId: OrganizationId): string {
    return organizationId ?? "platform";
  }

  private refill(organizationId: OrganizationId): { tokens: number; lastRefillMs: number } {
    const key = this.key(organizationId);
    const nowMs = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
      return bucket;
    }
    const elapsedSeconds = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedSeconds * this.refillTokensPerSecond);
    bucket.lastRefillMs = nowMs;
    return bucket;
  }

  /** Intenta consumir `tokens`; retorna `true` si había suficientes disponibles. */
  tryConsume(organizationId: OrganizationId, tokens = 1): boolean {
    // AG-09: sin esta validación, `tokens < 0` restaba un negativo
    // (`bucket.tokens -= tokens`), rellenando el bucket a capacidad máxima
    // al instante — bypass total del rate limit para esa organización. Los
    // tokens son unidades discretas, así que también se exige entero.
    if (Number.isNaN(tokens) || !Number.isFinite(tokens) || tokens < 0 || !Number.isInteger(tokens)) {
      throw new InvalidAmountError("TokenBucketRateLimiter.tryConsume", tokens);
    }
    const bucket = this.refill(organizationId);
    if (bucket.tokens < tokens) return false;
    bucket.tokens -= tokens;
    return true;
  }

  getAvailableTokens(organizationId: OrganizationId): number {
    return this.refill(organizationId).tokens;
  }

  reset(): void {
    this.buckets.clear();
  }
}
