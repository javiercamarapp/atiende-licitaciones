import type { JobStatus } from './types.js';

/**
 * Contadores en memoria por estado (REQ-019/observabilidad mínima pedida
 * para esta ronda). No es un exportador Prometheus real: `apps/api` ya usa
 * `prom-client`; exponer `/metrics` en este proceso queda documentado como
 * pendiente en el README (fuera de alcance para esta ronda de apps/worker).
 */
export class JobMetrics {
  private readonly counters = new Map<string, number>();

  private key(event: string, kind?: string): string {
    return kind ? `${event}:${kind}` : event;
  }

  inc(event: 'claimed' | 'succeeded' | 'retried' | 'dead' | 'cancelled' | 'fenced' | JobStatus, kind?: string): void {
    const k = this.key(event, kind);
    this.counters.set(k, (this.counters.get(k) ?? 0) + 1);
  }

  get(event: string, kind?: string): number {
    return this.counters.get(this.key(event, kind)) ?? 0;
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters.entries());
  }

  reset(): void {
    this.counters.clear();
  }
}
