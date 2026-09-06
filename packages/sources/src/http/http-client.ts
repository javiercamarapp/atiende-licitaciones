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
  /** Máximo de saltos de redirección a seguir antes de fallar explícitamente (SR-04, evita loops infinitos). */
  maxRedirects?: number;
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
  maxRedirects: 5,
} as const;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUSES.has(status);
}

/** Cabeceras que NUNCA deben reenviarse a un host distinto tras seguir una redirección (mismo criterio que aplica `fetch`/undici de forma nativa en un redirect cross-origin). */
const SENSITIVE_CROSS_HOST_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * Construye el `init` de la petición reentrante hacia el destino de una
 * redirección (SR-04), replicando el comportamiento estándar de `fetch`:
 * - Si el host de destino difiere del host original, se descartan cabeceras
 *   sensibles (`Authorization`/`Cookie`/`Proxy-Authorization`).
 * - Un 303 (o un 301/302 sobre una petición POST) degrada el método a GET y
 *   descarta el cuerpo, igual que hace `fetch` nativamente.
 */
function buildRedirectInit(init: HttpRequestOptions, originalHost: string, nextHost: string, status: number): HttpRequestOptions {
  const headers = new Headers(init.headers);
  if (nextHost !== originalHost) {
    for (const name of SENSITIVE_CROSS_HOST_HEADERS) headers.delete(name);
  }

  let method = init.method ?? "GET";
  let body = init.body;
  const shouldDowngradeToGet = status === 303 || ((status === 301 || status === 302) && method.toUpperCase() === "POST");
  if (shouldDowngradeToGet) {
    method = "GET";
    body = undefined;
    headers.delete("content-type");
    headers.delete("content-length");
  }

  return { ...init, headers, method, body };
}

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
      maxRedirects: options.maxRedirects ?? DEFAULTS.maxRedirects,
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
    return this.requestInternal(url, init, 0);
  }

  /**
   * SR-04: una redirección se re-entra explícitamente a través de esta
   * misma función (con el host/URL de DESTINO), para que el throttle por
   * host, el espaciado mínimo y la pausa por 403 repetidos se apliquen
   * SIEMPRE al host que realmente atiende la petición — nunca solo al host
   * original. Antes del fix, `fetchWithTimeout` dejaba que `fetch` siguiera
   * el redirect de forma transparente DENTRO de una sola llamada, así que
   * `HostThrottleRegistry` nunca se enteraba de que la petición terminó en
   * otro host (confirmado con un experimento HTTP real, ver auditoría).
   */
  private async requestInternal(url: string, init: HttpRequestOptions, redirectsFollowed: number): Promise<Response> {
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

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) return response; // sin `Location` no hay a dónde seguir: se devuelve el 3xx tal cual.

        const nextUrl = new URL(location, url);
        if (nextUrl.protocol !== "https:") {
          throw new Error(
            `HttpClient: redirección rechazada a un esquema no-https (${nextUrl.protocol.replace(":", "")}) desde ${url} hacia ${nextUrl.toString()} (REQ-079: solo lectura sobre https).`,
          );
        }
        if (redirectsFollowed >= this.opts.maxRedirects) {
          throw new Error(`HttpClient: se excedió el máximo de redirecciones (${this.opts.maxRedirects}) siguiendo ${url}.`);
        }
        const nextInit = buildRedirectInit(init, host, nextUrl.host, response.status);
        return this.requestInternal(nextUrl.toString(), nextInit, redirectsFollowed + 1);
      }

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
      // SR-04: `redirect: "manual"` para que un 3xx cross-host se procese en `requestInternal`
      // (throttle/pausa del host de DESTINO) en vez de que `fetch` lo siga de forma transparente.
      return await this.opts.fetchImpl(url, { ...init, headers, redirect: "manual", signal: controller.signal });
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
