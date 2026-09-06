import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DbClient } from '@atiende/db';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedDb } from './helpers.js';

/**
 * LIMITACIÓN DE PGLITE (ver packages/db/README.md "Límites conocidos"): una
 * sola conexión/proceso, no hay múltiples backends concurrentes reales. Igual
 * que `packages/db/test/jobs-locking.test.ts`, lo que SÍ se prueba aquí es
 * que `JobQueue.claim()` ejecuta una única sentencia UPDATE atómica con
 * subquery `FOR UPDATE SKIP LOCKED`: N llamadas concurrentes (`Promise.all`)
 * contra la misma conexión reclaman, en conjunto, exactamente los jobs
 * disponibles, sin duplicados — el mismo invariante que protege a Postgres
 * real con conexiones concurrentes de verdad. La concurrencia de sistema
 * operativo real queda pendiente de un Postgres de pruebas (no disponible
 * en este entorno, ver README de este paquete).
 */
describe('JobQueue: reclamo atómico sin doble procesamiento', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('N workers > M jobs: cada job se reclama como máximo una vez', async () => {
    const jobIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { job } = await queue.enqueue('test_kind', { i });
      jobIds.push(job.id);
    }

    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => queue.claim(`worker-${i}`)));
    const claimedIds = claims.filter((j) => j !== undefined).map((j) => j!.id);

    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.sort()).toEqual([...jobIds].sort());
  });

  it('un job ya en running no es reclamado dos veces por workers adicionales', async () => {
    await queue.enqueue('test_kind', {});
    const [first, second] = await Promise.all([queue.claim('w1'), queue.claim('w2')]);
    const claimedCount = [first, second].filter(Boolean).length;
    expect(claimedCount).toBe(1);
  });

  it('un job claimeado incrementa attempts y queda en running con locked_by', async () => {
    const { job } = await queue.enqueue('test_kind', {});
    expect(job.attempts).toBe(0);
    const claimed = await queue.claim('worker-x');
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.status).toBe('running');
    expect(claimed?.lockedBy).toBe('worker-x');
  });
});

describe('JobQueue: WK-01 — claim() respeta max_attempts también en recuperación de lease (crash real)', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  /**
   * Reproduce el hallazgo WK-01 (docs/auditoria-1/worker.md): un proceso
   * worker que muere de verdad (crash/OOM/SIGKILL) NUNCA ejecuta el `catch`
   * de `Worker.process()` ni por tanto `fail()` — la única forma de que ese
   * job vuelva a estar disponible es la recuperación de lease expirado
   * dentro de `claim()` mismo. Antes de esta ronda, esa recuperación
   * incrementaba `attempts` sin comparar jamás contra `max_attempts`: un job
   * cuyo handler crashea repetidamente se re-reclamaba PARA SIEMPRE, sin
   * límite real, nunca `dead`. Este test simula 4 "crashes" consecutivos
   * (reclamo -> nunca `complete()`/`fail()` -> lease expira) sobre un job
   * con `maxAttempts=3` y confirma que, en cuanto el siguiente reclamo
   * excedería `max_attempts`, el job pasa a `dead` con un error explícito,
   * en vez de seguir `running` para siempre.
   */
  it('un job que crashea repetidamente (nunca completa/falla) termina en "dead", nunca "running" eterno', async () => {
    const { job } = await queue.enqueue('test_kind', {}, { maxAttempts: 3 });

    // "Crash" 1: se reclama (attempts=1, running) y nunca se completa/falla.
    const claim1 = await queue.claim('worker-crash', { leaseSeconds: 60 });
    expect(claim1?.id).toBe(job.id);
    expect(claim1?.attempts).toBe(1);
    expect(claim1?.status).toBe('running');
    await db.query(`update jobs set locked_at = now() - interval '120 seconds' where id = $1`, [job.id]);

    // "Crash" 2: recuperación de lease expirado (attempts=2, todavía <= maxAttempts=3).
    const claim2 = await queue.claim('worker-crash', { leaseSeconds: 60 });
    expect(claim2?.id).toBe(job.id);
    expect(claim2?.attempts).toBe(2);
    expect(claim2?.status).toBe('running');
    await db.query(`update jobs set locked_at = now() - interval '120 seconds' where id = $1`, [job.id]);

    // "Crash" 3: attempts=3 (== maxAttempts), sigue siendo un intento legítimo en curso (running).
    const claim3 = await queue.claim('worker-crash', { leaseSeconds: 60 });
    expect(claim3?.id).toBe(job.id);
    expect(claim3?.attempts).toBe(3);
    expect(claim3?.status).toBe('running');
    await db.query(`update jobs set locked_at = now() - interval '120 seconds' where id = $1`, [job.id]);

    // "Crash" 4: un cuarto reclamo excedería max_attempts (3+1=4 > 3) -> dead-letter
    // INMEDIATO dentro de claim(), sin entregarse jamás como "reclamado".
    const claim4 = await queue.claim('worker-crash', { leaseSeconds: 60 });
    expect(claim4).toBeUndefined();

    const finalRow = await queue.getById(job.id);
    expect(finalRow?.status).toBe('dead');
    expect(finalRow?.lastError).toMatch(/lease expirado tras 4 intentos/);
    expect(finalRow?.lockedBy).toBeNull();
    expect(finalRow?.lockedAt).toBeNull();

    // Un job "dead" nunca vuelve a ser reclamado, ni siquiera si el lease "expira" de nuevo.
    const claim5 = await queue.claim('worker-crash', { leaseSeconds: 60 });
    expect(claim5).toBeUndefined();
  });
});

describe('JobQueue: reintentos con backoff exponencial + jitter', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    vi.useFakeTimers();
    db = await createMigratedDb();
    queue = new JobQueue({ db, now: () => new Date(), backoff: { baseMs: 1000, factor: 2, jitterRatio: 0, maxMs: 60_000 } });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await db.close();
  });

  it('cada fallo reprograma next_run_at con backoff creciente hasta max_attempts, luego "dead"', async () => {
    const { job } = await queue.enqueue('test_kind', {}, { maxAttempts: 3 });

    // Intento 1: falla. Todas las referencias de tiempo se toman de `new Date()`
    // bajo fake timers (mismo reloj que usa `JobQueue`), NUNCA de columnas
    // `updated_at`/`created_at` (esas las pone un trigger de Postgres/PGlite
    // con SU PROPIO reloj real, independiente de `vi.useFakeTimers()`).
    const t1 = new Date();
    const claim1 = await queue.claim('w1');
    expect(claim1!.attempts).toBe(1);
    const afterFail1 = await queue.fail(claim1!, 'w1', 'boom-1');
    expect(afterFail1!.status).toBe('queued');
    const delay1 = afterFail1!.nextRunAt.getTime() - t1.getTime();
    expect(delay1).toBeGreaterThanOrEqual(900); // ~1000ms (jitter=0)

    // Avanza el reloj falso más allá de next_run_at para poder reclamarlo de nuevo.
    vi.setSystemTime(new Date(afterFail1!.nextRunAt.getTime() + 10));

    // Intento 2: falla.
    const t2 = new Date();
    const claim2 = await queue.claim('w1');
    expect(claim2!.id).toBe(job.id);
    expect(claim2!.attempts).toBe(2);
    const afterFail2 = await queue.fail(claim2!, 'w1', 'boom-2');
    expect(afterFail2!.status).toBe('queued');
    const delay2 = afterFail2!.nextRunAt.getTime() - t2.getTime();
    // Backoff exponencial: el segundo delay es aproximadamente el doble del primero.
    expect(delay2).toBeGreaterThan(delay1 * 1.5);

    vi.setSystemTime(new Date(afterFail2!.nextRunAt.getTime() + 10));

    // Intento 3 (== maxAttempts): falla -> dead letter con el último error.
    const claim3 = await queue.claim('w1');
    expect(claim3!.attempts).toBe(3);
    const afterFail3 = await queue.fail(claim3!, 'w1', 'boom-final');
    expect(afterFail3!.status).toBe('dead');
    expect(afterFail3!.lastError).toBe('boom-final');
    expect(afterFail3!.lockedBy).toBeNull();

    // Un job "dead" nunca vuelve a ser reclamado.
    const claim4 = await queue.claim('w1');
    expect(claim4).toBeUndefined();
  });

  it('el jitter mantiene el delay dentro del rango esperado (no determinista pero acotado)', async () => {
    const jitteredQueue = new JobQueue({ db, backoff: { baseMs: 1000, factor: 2, jitterRatio: 0.2, maxMs: 60_000 } });
    const { job } = await jitteredQueue.enqueue('test_kind', {}, { maxAttempts: 5 });
    const t0 = new Date();
    const claimed = await jitteredQueue.claim('w1');
    expect(claimed!.id).toBe(job.id);
    const failed = await jitteredQueue.fail(claimed!, 'w1', 'err');
    const delay = failed!.nextRunAt.getTime() - t0.getTime();
    // base=1000, attempt=1 -> pure=1000, jitter ±20% -> [800, 1200]
    expect(delay).toBeGreaterThanOrEqual(750);
    expect(delay).toBeLessThanOrEqual(1250);
  });
});

describe('JobQueue: lease expirado se recupera', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('un job running cuyo lease expiró es reclamable por otro worker', async () => {
    const { job } = await queue.enqueue('test_kind', {});
    const claimed = await queue.claim('worker-A', { leaseSeconds: 60 });
    expect(claimed!.id).toBe(job.id);

    // Con lease de 60s, un segundo worker NO debe poder reclamarlo de inmediato.
    const tooSoon = await queue.claim('worker-B', { leaseSeconds: 60 });
    expect(tooSoon).toBeUndefined();

    // Simula que el lease expiró: retrocede `locked_at` manualmente (worker-A "murió").
    await db.query(`update jobs set locked_at = now() - interval '120 seconds' where id = $1`, [job.id]);

    const recovered = await queue.claim('worker-B', { leaseSeconds: 60 });
    expect(recovered?.id).toBe(job.id);
    expect(recovered?.lockedBy).toBe('worker-B');
    // Recuperar un lease expirado cuenta como un nuevo intento (protege contra jobs zombie infinitos).
    expect(recovered?.attempts).toBe(2);
  });

  it('heartbeat extiende el lease y evita que otro worker lo recupere', async () => {
    const { job } = await queue.enqueue('test_kind', {});
    await queue.claim('worker-A', { leaseSeconds: 60 });

    // Retrocede el reloj como si hubiera pasado tiempo, pero el heartbeat lo refresca justo antes.
    await db.query(`update jobs set locked_at = now() - interval '55 seconds' where id = $1`, [job.id]);
    const beat = await queue.heartbeat(job.id, 'worker-A');
    expect(beat).toBe(true);

    const stillLocked = await queue.claim('worker-B', { leaseSeconds: 60 });
    expect(stillLocked).toBeUndefined();
  });
});

describe('JobQueue: cancelación', () => {
  it('cancelar un job queued lo deja fuera de circulación (dead) y no se reclama', async () => {
    const db = await createMigratedDb();
    const queue = new JobQueue({ db });
    const { job } = await queue.enqueue('test_kind', {});

    const cancelled = await queue.cancel(job.id, 'ya no se necesita');
    expect(cancelled?.status).toBe('dead');
    expect(cancelled?.lastError).toContain('ya no se necesita');

    const claimed = await queue.claim('w1');
    expect(claimed).toBeUndefined();
    await db.close();
  });

  it('cancelar un job running también lo detiene', async () => {
    const db = await createMigratedDb();
    const queue = new JobQueue({ db });
    const { job } = await queue.enqueue('test_kind', {});
    await queue.claim('w1');

    const cancelled = await queue.cancel(job.id, 'motivo');
    expect(cancelled?.status).toBe('dead');
    await db.close();
  });
});

describe('JobQueue: idempotencia por jobKey', () => {
  it('encolar dos veces con el mismo jobKey mientras el primero sigue activo no duplica', async () => {
    const db = await createMigratedDb();
    const queue = new JobQueue({ db });

    const first = await queue.enqueue('discover_tenders', { sourceId: 'dof' }, { jobKey: 'dof:window-1' });
    expect(first.deduped).toBe(false);

    const second = await queue.enqueue('discover_tenders', { sourceId: 'dof' }, { jobKey: 'dof:window-1' });
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from jobs where kind = 'discover_tenders' and payload ->> 'jobKey' = 'dof:window-1'`,
    );
    expect(rows[0].n).toBe(1);
    await db.close();
  });

  it('una vez terminado (succeeded), un nuevo jobKey (otra ventana) sí encola', async () => {
    const db = await createMigratedDb();
    const queue = new JobQueue({ db });

    const first = await queue.enqueue('discover_tenders', { sourceId: 'dof' }, { jobKey: 'dof:window-1' });
    const claimed = await queue.claim('w1');
    await queue.complete(claimed!.id, 'w1');

    // Distinta ventana (jobKey distinto) => nuevo job, no deduplicado.
    const second = await queue.enqueue('discover_tenders', { sourceId: 'dof' }, { jobKey: 'dof:window-2' });
    expect(second.deduped).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
    await db.close();
  });
});

describe('JobQueue: WK-10 — deadLetterPermanent (errores permanentes, sin ciclo de backoff)', () => {
  it('dead-letra inmediatamente en el primer intento, sin importar max_attempts', async () => {
    const db = await createMigratedDb();
    const queue = new JobQueue({ db });
    await queue.enqueue('test_kind', {}, { maxAttempts: 5 });
    const claimed = await queue.claim('w1');
    expect(claimed?.attempts).toBe(1); // muy lejos de max_attempts=5

    const dead = await queue.deadLetterPermanent(claimed!, 'w1', 'fuente_no_verificada:dof');
    expect(dead?.status).toBe('dead');
    expect(dead?.lastError).toBe('fuente_no_verificada:dof');
    expect(dead?.lockedBy).toBeNull();

    // Nunca vuelve a estar disponible (a diferencia de fail() con attempts < maxAttempts).
    const reclaim = await queue.claim('w2');
    expect(reclaim).toBeUndefined();
    await db.close();
  });
});

describe('JobQueue: complete', () => {
  it('complete limpia el lock y marca succeeded', async () => {
    const db = await createMigratedDb();
    const queue = new JobQueue({ db });
    const { job } = await queue.enqueue('test_kind', {});
    await queue.claim('w1');
    const done = await queue.complete(job.id, 'w1');
    expect(done?.status).toBe('succeeded');
    expect(done?.lockedBy).toBeNull();
    expect(done?.lockedAt).toBeNull();
    await db.close();
  });

  it('complete con el workerId equivocado no hace nada (protege contra confirmaciones cruzadas)', async () => {
    const db = await createMigratedDb();
    const queue = new JobQueue({ db });
    const { job } = await queue.enqueue('test_kind', {});
    await queue.claim('w1');
    const done = await queue.complete(job.id, 'w2-impostor');
    expect(done).toBeUndefined();
    const stillRunning = await queue.getById(job.id);
    expect(stillRunning?.status).toBe('running');
    await db.close();
  });
});
