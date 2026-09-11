import type { Logger } from '../logger.js';
import type { JobQueue } from '../queue/job-queue.js';

export interface KycSchedulerOptions {
  queue: JobQueue;
  intervalMs: number;
  now?: () => Date;
  logger?: Logger;
  enabled?: boolean;
}

/**
 * Encola `kyc_negative_screening` (REQ-112) periódicamente, SIN duplicar
 * dentro de la misma ventana de tiempo -- mismo patrón EXACTO que
 * `Scheduler` (`scheduler.ts`) usa para `discover_tenders`, simplificado a
 * un solo job de PLATAFORMA (sin `sourceId`/`orgId` por el que dividir: una
 * sola corrida evalúa a TODOS los tenants a la vez).
 */
export class KycScheduler {
  constructor(private readonly options: KycSchedulerOptions) {}

  private windowKey(now: Date): string {
    const windowStart = Math.floor(now.getTime() / this.options.intervalMs) * this.options.intervalMs;
    return `kyc_negative_screening:platform:${windowStart}`;
  }

  async tick(): Promise<{ enqueued: boolean }> {
    if (this.options.enabled === false) return { enqueued: false };
    const now = this.options.now?.() ?? new Date();
    const jobKey = this.windowKey(now);
    const { deduped, job } = await this.options.queue.enqueue('kyc_negative_screening', {}, { orgId: null, jobKey });
    if (!deduped) {
      this.options.logger?.info({ job_id: job.id }, 'kyc_negative_screening encolado por scheduler');
    }
    return { enqueued: !deduped };
  }

  /** Arranca un intervalo que llama `tick()` cada `pollIntervalMs`. Retorna una función para detenerlo. */
  start(pollIntervalMs: number): () => void {
    const timer = setInterval(() => {
      this.tick().catch((err) => this.options.logger?.error({ err: String(err) }, 'kyc scheduler.tick falló'));
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }
}
