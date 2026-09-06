import { classifyError, RunCancelledError } from "./errors.js";

/**
 * Política de reintentos con backoff exponencial y jitter (REQ-077/REQ-078).
 * El generador de aleatoriedad y el `sleep` son inyectables para que las
 * pruebas puedan usar fake timers sin esperar tiempo real.
 */
export interface RetryPolicyOptions {
  /** Número máximo de intentos, incluyendo el primero. Mínimo 1. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Aplica jitter completo (0..delay) en vez de un delay exacto. Por defecto true. */
  jitter?: boolean;
  /** Permite sobreescribir la clasificación reintentable/no-reintentable por defecto. */
  isRetryable?: (error: unknown) => boolean;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class RetryPolicy {
  private readonly opts: Required<Omit<RetryPolicyOptions, "isRetryable">> & {
    isRetryable?: (error: unknown) => boolean;
  };

  constructor(options: RetryPolicyOptions) {
    this.opts = {
      maxAttempts: Math.max(1, options.maxAttempts),
      baseDelayMs: options.baseDelayMs,
      maxDelayMs: options.maxDelayMs,
      jitter: options.jitter ?? true,
      random: options.random ?? Math.random,
      sleep: options.sleep ?? defaultSleep,
      isRetryable: options.isRetryable,
    };
  }

  /** Backoff exponencial: base * 2^(attempt-1), acotado a maxDelayMs, con jitter opcional. */
  computeDelay(attempt: number): number {
    const exponential = this.opts.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    const capped = Math.min(exponential, this.opts.maxDelayMs);
    if (!this.opts.jitter) return capped;
    return this.opts.random() * capped;
  }

  private isRetryable(error: unknown): boolean {
    if (this.opts.isRetryable) return this.opts.isRetryable(error);
    return classifyError(error) === "retryable";
  }

  /**
   * Ejecuta `fn` reintentando ante errores reintentables hasta `maxAttempts`.
   * Respeta `signal`: si se cancela mientras espera el backoff o antes de un
   * nuevo intento, lanza `RunCancelledError` de inmediato.
   */
  async execute<T>(fn: (attempt: number) => Promise<T>, signal?: AbortSignal, runId = "retry"): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      if (signal?.aborted) throw new RunCancelledError(runId);
      try {
        return await fn(attempt);
      } catch (error) {
        lastError = error;
        const isLastAttempt = attempt >= this.opts.maxAttempts;
        if (isLastAttempt || !this.isRetryable(error)) {
          throw error;
        }
        const delay = this.computeDelay(attempt);
        await this.opts.sleep(delay, signal);
      }
    }
    // Inalcanzable (maxAttempts >= 1 siempre entra al loop y retorna o lanza),
    // pero TypeScript exige un retorno o throw explícito.
    throw lastError;
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RunCancelledError("retry"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new RunCancelledError("retry"));
      },
      { once: true },
    );
  });
}
