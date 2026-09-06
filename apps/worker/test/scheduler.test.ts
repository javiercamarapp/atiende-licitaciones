import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient, DbExecutor } from '@atiende/db';
import { JobQueue } from '../src/queue/job-queue.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { SourceScheduleConfig } from '../src/scheduler/schedule-config.js';
import { createMigratedDb } from './helpers.js';

/**
 * Envuelve un `DbClient` real para capturar el SQL/params EXACTOS que
 * ejecuta cualquier código dentro de `db.transaction(fn)` (WK-15, ver
 * describe más abajo) — nunca un mock: la conexión real sigue ejecutando
 * cada sentencia contra PGlite, esto solo intercepta el texto en tránsito.
 */
function spyOnTransactionQueries(db: DbClient): { db: DbClient; queries: Array<{ sql: string; params: unknown[] }> } {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const spied: DbClient = {
    ...db,
    async transaction<T>(fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        const spiedTx: DbExecutor = {
          async query<Row = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            queries.push({ sql, params });
            return tx.query<Row>(sql, params);
          },
        };
        return fn(spiedTx);
      });
    },
  };
  return { db: spied, queries };
}

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
   *
   * **Nota de honestidad (WK-15, docs/auditoria-1/worker-reverificacion.md,
   * cierre de WK-04 PARCIAL)**: el SQL de este mecanismo
   * (`pg_advisory_xact_lock`) es **correcto para Postgres real**; este test,
   * en **PGlite, verifica solo la lógica secuencial** — que el código llama
   * al lock, hace el SELECT y decide bien "insertar" vs. "deduplicar" en el
   * orden correcto, NO que dos conexiones de sistema operativo reales
   * compitiendo de verdad por el mismo `pg_advisory_xact_lock` se serialicen
   * como Postgres real lo haría. PGlite (ver `packages/db/README.md`
   * "Límites conocidos": una sola conexión/proceso) serializa dos
   * `db.transaction()` lanzados con `Promise.all` de punta a punta sin
   * intercalado alguno (confirmado con un diagnóstico de orden de ejecución
   * durante la reverificación): la carrera que el advisory lock existe para
   * prevenir NUNCA llega a ocurrir en este entorno, así que este mismo test
   * pasaría IDÉNTICO sin el `pg_advisory_xact_lock`. Lo que este test SÍ
   * demuestra con certeza es la lógica secuencial correcta (dedupe bien
   * decidido en cada iteración); la garantía de SQL correcto se verifica
   * por separado y de forma más directa en "WK-15" (más abajo: el SQL
   * exacto que emite `enqueue()`). La verificación de concurrencia de motor
   * REAL contra Postgres queda explícitamente **PENDIENTE (ref. B-03: se
   * requiere un Postgres de pruebas en CI, no disponible en este entorno)**
   * — no se debe citar este test como evidencia de esa concurrencia real.
   */
  it('dos Scheduler concurrentes (dos procesos) nunca duplican el job de la misma fuente+ventana — 20 iteraciones (lógica secuencial en PGlite, NO concurrencia de motor real — ver nota WK-15)', async () => {
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

/**
 * WK-15 (docs/auditoria-1/worker-reverificacion.md, cierre de WK-04
 * PARCIAL): el test "dos Scheduler concurrentes" de arriba demuestra la
 * LÓGICA secuencial de `enqueue()`, no que el SQL en sí sea correcto contra
 * Postgres real — PGlite no puede demostrar eso (ver nota en ese test). Lo
 * que SÍ se puede verificar en cualquier entorno, sin necesidad de
 * concurrencia real, es que `JobQueue.enqueue()` EMITE el SQL correcto:
 * este describe intercepta las sentencias ejecutadas dentro de la
 * transacción (`spyOnTransactionQueries`, arriba) y confirma que la
 * primera es, textualmente, `select pg_advisory_xact_lock(...)` con la
 * clave estable `${kind}:${jobKey}` como parámetro — el mismo patrón que
 * `packages/db/README.md` documenta como necesario para que dos conexiones
 * REALES de Postgres se serialicen correctamente.
 */
describe('JobQueue.enqueue(): WK-15 — el SQL emitido usa pg_advisory_xact_lock con una clave estable', () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await createMigratedDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('la primera sentencia de la transacción es pg_advisory_xact_lock(hashtext($1)::bigint) con params=[`${kind}:${jobKey}`]', async () => {
    const { db: spiedDb, queries } = spyOnTransactionQueries(db);
    const queue = new JobQueue({ db: spiedDb });

    await queue.enqueue('discover_tenders', { sourceId: 'dof' }, { jobKey: 'dof:window-wk15' });

    expect(queries.length).toBeGreaterThanOrEqual(2); // advisory lock + SELECT (+ INSERT si no había fila previa)
    const [lockQuery] = queries;
    expect(lockQuery.sql).toContain('pg_advisory_xact_lock');
    expect(lockQuery.sql).toContain('hashtext($1)::bigint');
    // Clave ESTABLE: `${kind}:${jobKey}`, exactamente como documenta
    // job-queue.ts (ver comentario WK-04 dentro de `enqueue()`).
    expect(lockQuery.params).toEqual(['discover_tenders:dof:window-wk15']);
  });

  it('la clave del advisory lock es estable entre llamadas (mismo kind+jobKey -> mismo string, sin importar el payload)', async () => {
    const { db: spiedDb, queries } = spyOnTransactionQueries(db);
    const queue = new JobQueue({ db: spiedDb });

    await queue.enqueue('discover_tenders', { sourceId: 'dof', ronda: 1 }, { jobKey: 'dof:window-stable' });
    const firstLockParams = queries[0].params;

    // Segunda llamada con la MISMA (kind, jobKey) pero payload distinto
    // (deduplica, no inserta de nuevo): la clave del lock no debe cambiar.
    await queue.enqueue('discover_tenders', { sourceId: 'dof', ronda: 2 }, { jobKey: 'dof:window-stable' });
    const secondLockQuery = queries.find((q, idx) => idx > 0 && q.sql.includes('pg_advisory_xact_lock'));

    expect(secondLockQuery?.params).toEqual(firstLockParams);
    expect(secondLockQuery?.params).toEqual(['discover_tenders:dof:window-stable']);
  });

  it('un jobKey distinto produce una clave de lock distinta (sin colisión entre ventanas/fuentes)', async () => {
    const { db: spiedDb, queries } = spyOnTransactionQueries(db);
    const queue = new JobQueue({ db: spiedDb });

    await queue.enqueue('discover_tenders', { sourceId: 'dof' }, { jobKey: 'dof:window-1' });
    await queue.enqueue('discover_tenders', { sourceId: 'dof' }, { jobKey: 'dof:window-2' });

    const lockQueries = queries.filter((q) => q.sql.includes('pg_advisory_xact_lock'));
    expect(lockQueries).toHaveLength(2);
    expect(lockQueries[0].params).toEqual(['discover_tenders:dof:window-1']);
    expect(lockQueries[1].params).toEqual(['discover_tenders:dof:window-2']);
    expect(lockQueries[0].params).not.toEqual(lockQueries[1].params);
  });

  it('enqueue() SIN jobKey no abre transacción ni toma ningún advisory lock (solo el camino con jobKey lo necesita)', async () => {
    const { db: spiedDb, queries } = spyOnTransactionQueries(db);
    const queue = new JobQueue({ db: spiedDb });

    await queue.enqueue('discover_tenders', { sourceId: 'dof' }); // sin jobKey

    expect(queries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(false);
  });
});
