import type { Logger } from '../logger.js';
import { JobMetrics } from './metrics.js';
import type { JobQueue } from './job-queue.js';
import type { Job, JobHandler } from './types.js';

export interface WorkerOptions {
  queue: JobQueue;
  handlers: Record<string, JobHandler<any>>;
  workerId: string;
  logger: Logger;
  metrics?: JobMetrics;
  kinds?: string[];
  pollIntervalMs?: number;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  shutdownTimeoutMs?: number;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Bucle de un worker: reclama un job a la vez (`maxConcurrentJobs` real de
 * más de uno queda fuera de esta ronda: cada proceso `apps/worker` corre un
 * solo `Worker`; escalar horizontalmente se hace levantando más procesos,
 * cada uno con su propio `workerId`), lo ejecuta con heartbeat periódico
 * (extiende el lease vía `JobQueue.heartbeat`) y aplica reintentos/dead
 * letter a través de `JobQueue.fail`.
 *
 * Cierre ordenado (SIGTERM, ver `src/index.ts`): `stop()` dice de inmediato
 * "no reclames más jobs", despierta el bucle si estaba dormido esperando
 * (`pollIntervalMs`) en vez de esperar a que expire el intervalo, y espera a
 * que el job en curso TERMINE (se complete o falle normalmente, liberando su
 * lock vía `complete`/`fail` como cualquier otro final). Si el handler no
 * responde dentro de `shutdownTimeoutMs`, se activa `AbortSignal` para que
 * un handler cooperativo (p. ej. `discover_tenders`, que lo pasa a `fetch`)
 * pueda cortar limpio; un handler que ignore la señal puede seguir bloqueando
 * el cierre (documentado en README §Pendientes: no hay forma de matar un
 * `Promise` de JS a la fuerza).
 */
export class Worker {
  readonly metrics: JobMetrics;
  private stopping = false;
  private loopPromise?: Promise<void>;
  private processingPromise: Promise<void> = Promise.resolve();
  private currentAbort?: AbortController;
  private wakeResolvers: Array<() => void> = [];

  constructor(private readonly options: WorkerOptions) {
    this.metrics = options.metrics ?? new JobMetrics();
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopPromise = this.loop();
  }

  private async loop(): Promise<void> {
    const { queue } = this.options;
    while (!this.stopping) {
      const job = await queue.claim(this.options.workerId, {
        kinds: this.options.kinds,
        leaseSeconds: this.options.leaseSeconds ?? 60,
      });
      if (!job) {
        if (this.stopping) break;
        await this.sleep(this.options.pollIntervalMs ?? 1000);
        continue;
      }
      this.metrics.inc('claimed', job.kind);
      this.processingPromise = this.process(job);
      await this.processingPromise;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wakeResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private wake(): void {
    const resolvers = this.wakeResolvers.splice(0);
    for (const resolve of resolvers) resolve();
  }

  private async process(job: Job): Promise<void> {
    const { queue, handlers, workerId, logger } = this.options;
    const childLogger = logger.child({ job_id: job.id, correlation_id: job.id, kind: job.kind, attempts: job.attempts });
    const handler = handlers[job.kind];
    const abortController = new AbortController();
    this.currentAbort = abortController;

    if (!handler) {
      childLogger.error('sin handler registrado para este tipo de job');
      await queue.fail(job, workerId, `sin_handler_registrado:${job.kind}`);
      this.metrics.inc(job.attempts >= job.maxAttempts ? 'dead' : 'retried', job.kind);
      this.currentAbort = undefined;
      return;
    }

    const heartbeatMs = this.options.heartbeatIntervalMs ?? 15_000;
    const heartbeatTimer = setInterval(() => {
      queue.heartbeat(job.id, workerId).catch((err) => childLogger.warn({ err: describeError(err) }, 'fallo de heartbeat'));
    }, heartbeatMs);

    try {
      childLogger.info('job iniciado');
      await handler(job, { job, logger: childLogger, signal: abortController.signal });
      await queue.complete(job.id, workerId);
      this.metrics.inc('succeeded', job.kind);
      childLogger.info('job completado');
    } catch (error) {
      const message = describeError(error);
      childLogger.error({ err: message }, 'job falló');
      const updated = await queue.fail(job, workerId, message);
      this.metrics.inc(updated?.status === 'dead' ? 'dead' : 'retried', job.kind);
    } finally {
      clearInterval(heartbeatTimer);
      this.currentAbort = undefined;
    }
  }

  /**
   * Cierre ordenado: deja de reclamar jobs nuevos de inmediato y espera a
   * que el job en curso (si lo hay) TERMINE normalmente (se completa o
   * falla, liberando su lock), hasta `shutdownTimeoutMs`. Si el handler no
   * respeta `AbortSignal` y sigue corriendo pasado ese plazo, `stop()`
   * igual resuelve (nunca cuelga el apagado del proceso indefinidamente);
   * el job en cuestión queda corriendo en segundo plano hasta que el
   * `Promise` del handler eventualmente se asiente por su cuenta (JS no
   * puede forzar la cancelación de una `Promise` en curso — ver README
   * §Pendientes: los handlers deben ser cooperativos con `signal` para un
   * cierre limpio de verdad). Idempotente: llamar dos veces no falla.
   */
  async stop(timeoutMs = this.options.shutdownTimeoutMs ?? 30_000): Promise<void> {
    this.stopping = true;
    this.wake();

    if (this.currentAbort) {
      const abort = this.currentAbort;
      let timedOut = false;
      await Promise.race([
        this.processingPromise.catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            timedOut = true;
            abort.abort();
            resolve();
          }, timeoutMs);
        }),
      ]);
      if (timedOut) return; // no esperamos loopPromise: el handler terco sigue corriendo en segundo plano.
    }

    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = undefined;
  }
}
