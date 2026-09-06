import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { JobQueue } from '../src/queue/job-queue.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { SourceScheduleConfig } from '../src/scheduler/schedule-config.js';
import { createMigratedDb } from './helpers.js';

describe('Scheduler: unicidad por (tipo, fuente, ventana) — REQ-146/REQ-150', () => {
  let db: DbClient;
  let queue: JobQueue;
  let currentTime: Date;

  const schedules: SourceScheduleConfig[] = [
    { sourceId: 'dof', intervalMs: 60_000 },
    { sourceId: 'compras-mx', intervalMs: 60_000 },
  ];

  beforeEach(async () => {
    db = await createMigratedDb();
    currentTime = new Date('2026-09-05T10:00:00.000Z');
    queue = new JobQueue({ db, now: () => currentTime });
  });

  afterEach(async () => {
    await db.close();
  });

  it('varios tick() dentro de la misma ventana encolan un solo job por fuente', async () => {
    const scheduler = new Scheduler({ queue, schedules, now: () => currentTime });

    const first = await scheduler.tick();
    expect(first.enqueued).toBe(2); // dof + compras-mx
    expect(first.deduped).toBe(0);

    // Reintenta varias veces dentro de la misma ventana (simula reinicios/polling frecuente).
    const second = await scheduler.tick();
    expect(second.enqueued).toBe(0);
    expect(second.deduped).toBe(2);

    const third = await scheduler.tick();
    expect(third.deduped).toBe(2);

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from jobs where kind = 'discover_tenders'`,
    );
    expect(rows[0].n).toBe(2);
  });

  it('avanzar a la siguiente ventana sí encola un nuevo job, sin duplicar el anterior', async () => {
    const scheduler = new Scheduler({ queue, schedules, now: () => currentTime });
    await scheduler.tick();

    currentTime = new Date(currentTime.getTime() + 61_000); // siguiente ventana de 60s
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(2);
    expect(result.deduped).toBe(0);

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from jobs where kind = 'discover_tenders'`,
    );
    expect(rows[0].n).toBe(4); // 2 fuentes x 2 ventanas
  });

  it('una fuente deshabilitada (enabled: false) nunca se encola', async () => {
    const disabled: SourceScheduleConfig[] = [{ sourceId: 'dof', intervalMs: 60_000, enabled: false }];
    const scheduler = new Scheduler({ queue, schedules: disabled, now: () => currentTime });
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(0);
    expect(result.deduped).toBe(0);

    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from jobs`);
    expect(rows[0].n).toBe(0);
  });

  it('el job encolado ya trae sourceId en el payload para que discover_tenders sepa qué conector correr', async () => {
    const scheduler = new Scheduler({ queue, schedules: [{ sourceId: 'dof', intervalMs: 60_000 }], now: () => currentTime });
    await scheduler.tick();
    const { rows } = await db.query<{ payload: { sourceId: string } }>(`select payload from jobs limit 1`);
    expect(rows[0].payload.sourceId).toBe('dof');
  });

  /**
   * WK-04 (docs/auditoria-1/worker.md): reproduce el escenario exacto que
   * confirmó la auditoría 5/5 veces — dos procesos `apps/worker`, cada uno
   * con su propio `Scheduler`/`JobQueue` (el modo de escalado horizontal que
   * el propio README recomienda), llamando `tick()` CONCURRENTEMENTE sobre
   * la MISMA ventana de la MISMA fuente. Antes de esta ronda, `enqueue()`
   * hacía lectura-luego-inserción sin ningún lock, así que ambos veían "no
   * existe todavía" y ambos insertaban -> 2 jobs duplicados. Ahora
   * `enqueue()` serializa esa clave con `pg_advisory_xact_lock` dentro de
   * una transacción (ver `JobQueue.enqueue`), así que el segundo scheduler
   * en llegar espera a que el primero haga commit y entonces sí ve la fila
   * ya insertada (deduped). Se repite 20 veces (una por ventana distinta)
   * para no depender de una única corrida con suerte.
   */
  it('dos Scheduler concurrentes (dos procesos) nunca duplican el job de la misma fuente+ventana — 20 iteraciones', async () => {
    const schedulesOneSource: SourceScheduleConfig[] = [{ sourceId: 'dof', intervalMs: 60_000 }];
    const queueA = new JobQueue({ db, now: () => currentTime });
    const queueB = new JobQueue({ db, now: () => currentTime });
    const schedulerA = new Scheduler({ queue: queueA, schedules: schedulesOneSource, now: () => currentTime });
    const schedulerB = new Scheduler({ queue: queueB, schedules: schedulesOneSource, now: () => currentTime });

    for (let i = 0; i < 20; i++) {
      // Cada iteración usa una ventana nueva (avanza más de intervalMs) para
      // que cada ronda ejercite el mismo camino de "primera vez" bajo
      // concurrencia real, no solo el camino ya-deduplicado.
      currentTime = new Date(currentTime.getTime() + 61_000);
      const [resultA, resultB] = await Promise.all([schedulerA.tick(), schedulerB.tick()]);

      // Exactamente uno de los dos procesos debió encolar; el otro debió
      // deduplicar contra la fila que el primero insertó.
      expect(resultA.enqueued + resultB.enqueued).toBe(1);
      expect(resultA.deduped + resultB.deduped).toBe(1);

      const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from jobs where kind = 'discover_tenders'`);
      // Exactamente un job total por ventana transcurrida (1 por iteración):
      // ninguna ventana quedó duplicada.
      expect(rows[0].n).toBe(i + 1);
    }
  });
});
