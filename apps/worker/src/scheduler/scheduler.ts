import type { Logger } from '../logger.js';
import type { JobQueue } from '../queue/job-queue.js';
import type { SourceScheduleConfig } from './schedule-config.js';

export interface SchedulerOptions {
  queue: JobQueue;
  schedules: SourceScheduleConfig[];
  now?: () => Date;
  logger?: Logger;
}

export interface TickResult {
  enqueued: number;
  deduped: number;
}

/**
 * Encola `discover_tenders` periódicamente por fuente (y por org, si
 * `orgId` está definido) sin duplicar dentro de la misma ventana de tiempo
 * (REQ-146/REQ-150, unicidad por `(tipo, fuente, ventana)`).
 *
 * La "ventana" es el intervalo `[floor(now/intervalMs)*intervalMs, +intervalMs)`
 * de esa fuente; la clave de idempotencia del job (`payload.jobKey`, ver
 * `JobQueue.enqueue`) codifica fuente+org+inicio de ventana, así que llamar
 * `tick()` muchas veces dentro de la misma ventana (p. ej. cada
 * `pollIntervalMs` del propio scheduler, o tras un reinicio del proceso)
 * nunca produce un segundo job mientras el primero siga `queued`/`running`.
 */
export class Scheduler {
  constructor(private readonly options: SchedulerOptions) {}

  private windowKey(config: SourceScheduleConfig, now: Date): string {
    const windowStart = Math.floor(now.getTime() / config.intervalMs) * config.intervalMs;
    return `discover_tenders:${config.sourceId}:${config.orgId ?? 'platform'}:${windowStart}`;
  }

  async tick(): Promise<TickResult> {
    const now = this.options.now?.() ?? new Date();
    let enqueued = 0;
    let deduped = 0;

    for (const config of this.options.schedules) {
      if (config.enabled === false) continue;
      const jobKey = this.windowKey(config, now);
      const { deduped: wasDeduped, job } = await this.options.queue.enqueue(
        'discover_tenders',
        { sourceId: config.sourceId },
        { orgId: config.orgId ?? null, jobKey },
      );
      if (wasDeduped) {
        deduped += 1;
      } else {
        enqueued += 1;
        this.options.logger?.info({ source: config.sourceId, job_id: job.id }, 'discover_tenders encolado por scheduler');
      }
    }

    return { enqueued, deduped };
  }

  /** Arranca un intervalo que llama `tick()` cada `pollIntervalMs`. Retorna una función para detenerlo. */
  start(pollIntervalMs: number): () => void {
    const timer = setInterval(() => {
      this.tick().catch((err) => this.options.logger?.error({ err: String(err) }, 'scheduler.tick falló'));
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }
}
