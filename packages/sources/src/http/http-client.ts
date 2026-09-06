import { type Clock, HostThrottleRegistry, realClock } from "./host-throttle.js";
import { computeBackoffDelayMs, isRetryableStatus, parseRetryAfterMs } from "./retry.js";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly bodyText: string,
  ) {
    super(`HTTP ${status} al solicitar ${url}`);
    this.name = "HttpError";
  }
}

export class HostPausedError extends Error {
  constructor(public readonly host: string) {
    super(
      `El host ${host} está en pausa total tras múltiples respuestas 403 consecutivas ` +
        "(REQ-077). Requiere `resetHostPause()` explícito para reanudar.",
    );
    this.name = "HostPausedError";
  }
}

export interface HttpClientOptions {
  /** User-Agent identificable exigido por REQ-079 (ej. "AtiendeLicitacionesBot/1.0 (+https://atiende.mx/bot)"). */
  userAgent: string;
  timeoutMs?: number;
  /** Número de reintentos ADICIONALES al intento inicial. */
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Conexiones simultáneas máximas por host (REQ-076: 1-2). */
  concurrencyPerHost?: number;
  /** Espaciado mínimo entre inicios de petición por host, en ms (REQ-079: ≤1 req/s -> 1000). */
  minIntervalMsPerHost?: number;
  /** Nº de 403 consecutivos de un host antes de pausarlo por completo (REQ-077). */
  forbiddenPauseThreshold?: number;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  onRetry?: (info: { url: string; attempt: number; status?: number; delayMs: number; reason: string }) => void;
}

export interface HttpRequestOptions extends RequestInit {
  /** Sobreescribe `maxRetries` solo para esta petición. */
  maxRetries?: number;
}

const DEFAULTS = {
  timeoutMs: 15_000,
  maxRetries: 3,
  retryBaseDelayMs: 500,
  retryMaxDelayMs: 20_000,
  concurrencyPerHost: 2,
  minIntervalMsPerHost: 1000,
  forbiddenPauseThreshold: 3,
} as const;

/**
 * Cliente HTTP inyectable con timeout, reintentos con backoff exponencial +
 * jitter para 429/5xx/errores de red, respeto de `Retry-After`, límite de
 * concurrencia y de tasa por host, User-Agent identificable, y pausa total
 * ante 403 repetidos (REQ-076/077/079). Todas las dependencias de tiempo
 * (`clock`, `random`) son inyectables para pruebas deterministas con fake
 * timers.
 */
export class HttpClient {
  private readonly opts: Required<Omit<HttpClientOptions, "onRetry">> & Pick<HttpClientOptions, "onRetry">;
  private readonly throttles: HostThrottleRegistry;
  private readonly consecutiveForbidden = new Map<string, number>();
  private readonly pausedHosts = new Set<string>();

  constructor(options: HttpClientOptions) {
    this.opts = {
      userAgent: options.userAgent,
      timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULTS.retryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs ?? DEFAULTS.retryMaxDelayMs,
      concurrencyPerHost: options.concurrencyPerHost ?? DEFAULTS.concurrencyPerHost,
      minIntervalMsPerHost: options.minIntervalMsPerHost ?? DEFAULTS.minIntervalMsPerHost,
      forbiddenPauseThreshold: options.forbiddenPauseThreshold ?? DEFAULTS.forbiddenPauseThreshold,
      fetchImpl: options.fetchImpl ?? fetch,
      clock: options.clock ?? realClock,
      random: options.random ?? Math.random,
      onRetry: options.onRetry,
    };
    this.throttles = new HostThrottleRegistry(this.opts.concurrencyPerHost, this.opts.minIntervalMsPerHost, this.opts.clock);
  }

  /** Quita la pausa total de un host (acción explícita/manual, nunca automática). */
  resetHostPause(host: string): void {
    this.pausedHosts.delete(host);
    this.consecutiveForbidden.delete(host);
  }

  isHostPaused(host: string): boolean {
    return this.pausedHosts.has(host);
  }

  async request(url: string, init: HttpRequestOptions = {}): Promise<Response> {
    const host = new URL(url).host;
    if (this.pausedHosts.has(host)) {
      throw new HostPausedError(host);
    }
    const maxRetries = init.maxRetries ?? this.opts.maxRetries;
    const throttle = this.throttles.forHost(host);

    for (let attempt = 0; ; attempt += 1) {
      const release = await throttle.acquire();
      let response: Response;
      try {
        response = await this.fetchWithTimeout(url, init);
      } catch (error) {
        release();
        if (attempt < maxRetries) {
          const delayMs = computeBackoffDelayMs({
            attempt,
            baseDelayMs: this.opts.retryBaseDelayMs,
            maxDelayMs: this.opts.retryMaxDelayMs,
            random: this.opts.random,
          });
          this.opts.onRetry?.({ url, attempt, delayMs, reason: (error as Error).message });
          await this.opts.clock.sleep(delayMs);
          continue;
        }
        throw error;
      }
      release();

      if (response.status === 403) {
        const count = (this.consecutiveForbidden.get(host) ?? 0) + 1;
        this.consecutiveForbidden.set(host, count);
        if (count >= this.opts.forbiddenPauseThreshold) {
          this.pausedHosts.add(host);
          throw new HostPausedError(host);
        }
        throw new HttpError(403, url, await safeText(response));
      }
      this.consecutiveForbidden.set(host, 0);

      if (isRetryableStatus(response.status)) {
        if (attempt < maxRetries) {
          const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), this.opts.clock.now());
          const delayMs =
            retryAfterMs ??
            computeBackoffDelayMs({
              attempt,
              baseDelayMs: this.opts.retryBaseDelayMs,
              maxDelayMs: this.opts.retryMaxDelayMs,
              random: this.opts.random,
            });
          this.opts.onRetry?.({ url, attempt, status: response.status, delayMs, reason: "retryable-status" });
          await this.opts.clock.sleep(delayMs);
          continue;
        }
        throw new HttpError(response.status, url, await safeText(response));
      }

      return response;
    }
  }

  private async fetchWithTimeout(url: string, init: HttpRequestOptions): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    try {
      const headers = new Headers(init.headers);
      if (!headers.has("User-Agent")) headers.set("User-Agent", this.opts.userAgent);
      return await this.opts.fetchImpl(url, { ...init, headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
