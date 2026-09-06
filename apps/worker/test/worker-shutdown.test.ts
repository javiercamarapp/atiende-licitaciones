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

  /**
   * WK-02 (docs/auditoria-1/worker.md): fencing token. Reproduce el
   * escenario exacto que confirmó la auditoría — el lease de un job expira
   * mientras el worker original (`worker-A`) SIGUE VIVO ejecutando el
   * handler, y otro worker (`worker-B`) lo reclama (p. ej. porque el
   * heartbeat de A se retrasó). Antes de esta ronda, `Worker.process()`
   * descartaba el valor booleano de `heartbeat()` con un `.catch()`
   * fire-and-forget: worker-A JAMÁS se enteraba de que perdió el lease y
   * seguía ejecutando el handler hasta el final, con el riesgo real de
   * producir un efecto secundario duplicado (p. ej. dos POST a apps/api) —
   * confirmado con doble reclamo real por la auditoría. Ahora: el heartbeat
   * periódico de `Worker` verifica el `fencingToken` (`job.attempts` en el
   * momento del claim) y, si detecta que ya no es dueño, aborta el
   * `AbortSignal` del handler y garantiza que el resultado NUNCA se
   * persiste (ni `complete()` ni `fail()`), sin importar cómo termine el
   * handler a partir de ahí.
   */
  it('WK-02: si el heartbeat detecta que se perdió el lease (fencing), aborta el handler y NO persiste ningún resultado', async () => {
    let sawAbort = false;
    let effectApplied = false;

    const handler: JobHandler = async (_job, ctx) => {
      const start = Date.now();
      while (!ctx.signal.aborted && Date.now() - start < 3000) {
        await sleep(5);
      }
      sawAbort = ctx.signal.aborted;
      // Si el handler NUNCA vio el abort, habría seguido y producido un
      // efecto secundario real (p. ej. un POST a apps/api) — justo lo que
      // WK-02 dice que pasaba antes de esta ronda.
      if (!ctx.signal.aborted) effectApplied = true;
    };

    const { job } = await queue.enqueue('fenced_kind', {});
    const worker = new Worker({
      queue,
      handlers: { fenced_kind: handler },
      workerId: 'worker-A',
      logger: silentLogger(),
      pollIntervalMs: 10,
      heartbeatIntervalMs: 20, // heartbeat frecuente para que la prueba no dependa de tiempos largos
    });

    worker.start();
    while ((await queue.getById(job.id))?.status !== 'running') await sleep(5);

    // Simula: el lease de worker-A expiró y worker-B lo reclamó MIENTRAS
    // worker-A sigue vivo ejecutando el handler (el escenario de WK-02).
    await db.query(`update jobs set locked_at = now() - interval '120 seconds' where id = $1`, [job.id]);
    const reclaimedByB = await queue.claim('worker-B', { leaseSeconds: 60 });
    expect(reclaimedByB?.id).toBe(job.id);
    // WK-14: `locked_by` lleva un lease token embebido (`${workerId}::${uuid}`),
    // ya no es el `workerId` plano.
    expect(reclaimedByB?.lockedBy).toMatch(/^worker-B::/);

    // El próximo heartbeat automático de worker-A debe detectar `false` y abortar.
    const deadline = Date.now() + 2000;
    while (!sawAbort && Date.now() < deadline) await sleep(10);
    expect(sawAbort).toBe(true);
    expect(effectApplied).toBe(false);

    await worker.stop();

    // worker-A NUNCA debió persistir nada: el job sigue siendo de worker-B,
    // sin tocar (ni completado, ni fallado, ni recontado como reintento).
    const finalRow = await queue.getById(job.id);
    expect(finalRow?.lockedBy).toBe(reclaimedByB?.lockedBy);
    expect(finalRow?.status).toBe('running');
    expect(finalRow?.attempts).toBe(2); // 1 (worker-A) + 1 (worker-B), nunca más
    expect(worker.metrics.get('fenced', 'fenced_kind')).toBe(1);
    expect(worker.metrics.get('succeeded', 'fenced_kind')).toBe(0);
  });

  /**
   * WK-10 (docs/auditoria-1/worker.md): antes de esta ronda, un error
   * PERMANENTE (fuente no configurada/no verificada, un 4xx de apps/api
   * salvo 429, validación) se trataba igual que cualquier error transitorio
   * — se reprogramaba con backoff exponencial hasta agotar `max_attempts`.
   * Reintentar un error permanente nunca cambia el resultado, así que es
   * puro desperdicio de capacidad de worker. Este test usa un handler que
   * lanza un error marcado `permanent: true` (el mismo mecanismo que usan
   * `NotConfiguredError`/`IngestApiError` 4xx) con `maxAttempts: 5`, y
   * confirma que el job muere en el PRIMER intento, sin pasar por
   * `queued`/backoff.
   */
  it('WK-10: un error permanente dead-letra en el primer intento, sin gastar el ciclo de backoff', async () => {
    class PermanentDemoError extends Error {
      readonly permanent = true as const;
    }
    const { job } = await queue.enqueue('permanent_kind', {}, { maxAttempts: 5 });
    const worker = new Worker({
      queue,
      handlers: {
        permanent_kind: async () => {
          throw new PermanentDemoError('fuente_no_verificada:dof');
        },
      },
      workerId: 'w-permanent',
      logger: silentLogger(),
      pollIntervalMs: 10,
    });

    worker.start();
    while ((await queue.getById(job.id))?.status === 'running') await sleep(5);
    await worker.stop();

    const finalRow = await queue.getById(job.id);
    expect(finalRow?.status).toBe('dead');
    expect(finalRow?.attempts).toBe(1); // nunca se reprogramó ni consumió más intentos
    expect(finalRow?.lastError).toContain('fuente_no_verificada:dof');
    expect(worker.metrics.get('dead', 'permanent_kind')).toBe(1);
    expect(worker.metrics.get('retried', 'permanent_kind')).toBe(0);
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
