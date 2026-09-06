import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { JobQueue } from '../src/queue/job-queue.js';
import { Worker } from '../src/queue/worker.js';
import { createMigratedDb, silentLogger, sleep } from './helpers.js';
import type { JobHandler } from '../src/queue/types.js';

describe('Worker: cierre ordenado (SIGTERM)', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('deja terminar el job en curso, libera el lock, y no reclama nuevos jobs tras stop()', async () => {
    const { job: job1 } = await queue.enqueue('slow_kind', {});
    const { job: job2 } = await queue.enqueue('slow_kind', {});

    let job1Started = false;
    let job1Finished = false;
    const handler: JobHandler = async (job) => {
      if (job.id === job1.id) {
        job1Started = true;
        await sleep(150); // simula trabajo en curso al momento del SIGTERM
        job1Finished = true;
      }
    };

    const worker = new Worker({
      queue,
      handlers: { slow_kind: handler },
      workerId: 'w-shutdown',
      logger: silentLogger(),
      pollIntervalMs: 20,
      shutdownTimeoutMs: 5000,
    });

    worker.start();
    // Espera a que reclame y empiece el primer job.
    while (!job1Started) await sleep(5);

    // Dispara el cierre ordenado MIENTRAS el job1 sigue corriendo.
    const stopPromise = worker.stop();
    // stop() no debe resolver antes de que el handler termine.
    await sleep(30);
    expect(job1Finished).toBe(false);

    await stopPromise;
    expect(job1Finished).toBe(true);

    const finishedJob1 = await queue.getById(job1.id);
    expect(finishedJob1?.status).toBe('succeeded');
    expect(finishedJob1?.lockedBy).toBeNull();
    expect(finishedJob1?.lockedAt).toBeNull();

    // job2 nunca se tocó: sigue "queued", sin lock (el worker se detuvo antes de reclamarlo).
    const untouchedJob2 = await queue.getById(job2.id);
    expect(untouchedJob2?.status).toBe('queued');
    expect(untouchedJob2?.lockedBy).toBeNull();
  });

  it('si el handler no respeta AbortSignal, stop() igual resuelve tras shutdownTimeoutMs (no cuelga para siempre)', async () => {
    const { job } = await queue.enqueue('stubborn_kind', {});
    let handlerSettled = false;

    const handler: JobHandler = async () => {
      await sleep(500); // ignora la señal a propósito
      handlerSettled = true;
    };

    const worker = new Worker({
      queue,
      handlers: { stubborn_kind: handler },
      workerId: 'w-stubborn',
      logger: silentLogger(),
      pollIntervalMs: 10,
      shutdownTimeoutMs: 50, // mucho menor que los 500ms del handler
    });

    worker.start();
    while ((await queue.getById(job.id))?.status !== 'running') await sleep(5);

    const startedAt = Date.now();
    await worker.stop();
    const elapsedMs = Date.now() - startedAt;

    // stop() resuelve sin esperar los 500ms completos del handler terco
    // (el AbortSignal se dispara, pero un handler que lo ignora sigue
    // corriendo en segundo plano — ver README §Pendientes: JS no puede matar
    // una Promise a la fuerza). Lo importante es que el proceso no se cuelga.
    expect(elapsedMs).toBeLessThan(480);
    expect(handlerSettled).toBe(false);

    // Limpieza: deja que el handler terco termine de verdad ANTES de que
    // `afterEach` cierre la base de datos, para no dejar una promesa
    // colgada que intente usar una conexión ya cerrada en la prueba
    // siguiente (ruido de "unhandled rejection" ajeno a lo que se prueba
    // aquí, que es únicamente que `stop()` no cuelga el apagado).
    while (!handlerSettled) await sleep(20);
  });

  it('llamar stop() dos veces es seguro (idempotente)', async () => {
    const worker = new Worker({
      queue,
      handlers: {},
      workerId: 'w-idle',
      logger: silentLogger(),
      pollIntervalMs: 10,
    });
    worker.start();
    await sleep(20);
    await worker.stop();
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it('métricas: cuenta succeeded/retried/dead por tipo de job', async () => {
    const { job: okJob } = await queue.enqueue('ok_kind', {});
    const { job: badJob } = await queue.enqueue('bad_kind', {}, { maxAttempts: 1 });

    const worker = new Worker({
      queue,
      handlers: {
        ok_kind: async () => undefined,
        bad_kind: async () => {
          throw new Error('falla a propósito');
        },
      },
      workerId: 'w-metrics',
      logger: silentLogger(),
      pollIntervalMs: 10,
    });

    worker.start();
    while ((await queue.getById(okJob.id))?.status !== 'succeeded') await sleep(5);
    while ((await queue.getById(badJob.id))?.status !== 'dead') await sleep(5);
    await worker.stop();

    expect(worker.metrics.get('succeeded', 'ok_kind')).toBe(1);
    expect(worker.metrics.get('dead', 'bad_kind')).toBe(1);
  });
});
