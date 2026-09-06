import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import type { DbClient } from '@atiende/db';
import { JobQueue } from '../src/queue/job-queue.js';
import { Worker } from '../src/queue/worker.js';
import { createMigratedDb, sleep } from './helpers.js';
import type { Logger } from '../src/logger.js';
import type { JobHandler } from '../src/queue/types.js';

interface LogLine {
  msg: string;
  job_id: string;
  correlation_id: string;
  kind: string;
  worker_id: string;
}

/**
 * Logger real de pino (misma librería y mismo mecanismo `child()` que
 * producción, no un doble artesanal) escribiendo a un buffer en memoria, para
 * poder afirmar sobre las LÍNEAS REALES emitidas en vez de sobre el objeto de
 * bindings.
 */
function capturingLogger(): { logger: Logger; lines: () => LogLine[] } {
  const raw: string[] = [];
  const logger = pino(
    { level: 'info', base: { app: 'atiende-worker' } },
    { write: (chunk: string) => void raw.push(chunk) },
  ) as Logger;
  return {
    logger,
    lines: () =>
      raw
        .join('')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as LogLine),
  };
}

/**
 * WK6-02 (docs/auditoria-2/worker-agentes.md, ALTA): el campo
 * `correlation_id` de cada línea de log del job era literalmente `job.id` —
 * el identificador INTERNO de la cola, distinto en cada job/intento — nunca
 * el identificador de NEGOCIO (`payload.correlationId`, p. ej. el `tenderId`)
 * exigido por REQ-171. Con eso, buscar en los logs por la convocatoria de
 * origen no agrupaba nada: cada corrida quedaba aislada bajo su propio id de
 * cola.
 */
describe('Worker: correlation_id de NEGOCIO en el log estructurado (WK6-02)', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  async function runOneJob(
    kind: string,
    payload: Record<string, unknown>,
    logger: Logger,
  ): Promise<string> {
    const { job } = await queue.enqueue(kind, payload);
    const handler: JobHandler = async () => {};
    const worker = new Worker({
      queue,
      handlers: { [kind]: handler },
      workerId: 'w-log-correlation',
      logger,
      pollIntervalMs: 10,
      shutdownTimeoutMs: 5000,
    });
    worker.start();
    while ((await queue.getById(job.id))?.status !== 'succeeded') await sleep(5);
    await worker.stop();
    return job.id;
  }

  it('cuando el payload trae correlationId de negocio, cada línea lleva ese valor en correlation_id y el id de cola SEPARADO en job_id', async () => {
    const businessCorrelationId = 'tender-11111111-2222-3333-4444-555555555555';
    const { logger, lines } = capturingLogger();

    const jobId = await runOneJob('run_agent', { correlationId: businessCorrelationId }, logger);

    const jobLines = lines().filter((l) => l.job_id === jobId);
    expect(jobLines.map((l) => l.msg)).toEqual(['job iniciado', 'job completado']);
    for (const line of jobLines) {
      // El identificador de NEGOCIO, no el de la cola.
      expect(line.correlation_id).toBe(businessCorrelationId);
      // `job_id` sigue presente por separado como identificador TÉCNICO.
      expect(line.job_id).toBe(jobId);
      expect(line.correlation_id).not.toBe(line.job_id);
    }
  });

  it('dos jobs distintos del MISMO expediente comparten correlation_id (una sola búsqueda en los logs agrupa toda la cadena) con job_id distinto cada uno', async () => {
    const businessCorrelationId = 'tender-99999999-8888-7777-6666-555555555555';
    const { logger, lines } = capturingLogger();

    const jobIdA = await runOneJob('run_agent', { correlationId: businessCorrelationId, agentName: 'analista_bases' }, logger);
    const jobIdB = await runOneJob('run_agent', { correlationId: businessCorrelationId, agentName: 'redactor_borrador' }, logger);

    expect(jobIdA).not.toBe(jobIdB);
    const chain = lines().filter((l) => l.correlation_id === businessCorrelationId);
    // Ambos jobs completos (2 líneas cada uno) bajo el MISMO correlation_id.
    expect(chain).toHaveLength(4);
    expect([...new Set(chain.map((l) => l.job_id))].sort()).toEqual([jobIdA, jobIdB].sort());
  });

  it('un job SIN correlationId de negocio (cualquier otro kind) conserva el comportamiento anterior: correlation_id = job.id, nunca queda vacío', async () => {
    const { logger, lines } = capturingLogger();

    const jobId = await runOneJob('discover_tenders', { sourceKey: 'dof' }, logger);

    const jobLines = lines().filter((l) => l.job_id === jobId);
    expect(jobLines.length).toBeGreaterThan(0);
    for (const line of jobLines) {
      expect(line.correlation_id).toBe(jobId);
    }
  });

  it('un correlationId presente pero no utilizable (cadena vacía o tipo equivocado) NO deja el log sin correlación: cae de vuelta a job.id', async () => {
    const { logger, lines } = capturingLogger();

    const jobIdEmpty = await runOneJob('run_agent', { correlationId: '' }, logger);
    const jobIdWrongType = await runOneJob('run_agent', { correlationId: 12345 }, logger);

    for (const jobId of [jobIdEmpty, jobIdWrongType]) {
      const jobLines = lines().filter((l) => l.job_id === jobId);
      expect(jobLines.length).toBeGreaterThan(0);
      for (const line of jobLines) {
        expect(line.correlation_id).toBe(jobId);
      }
    }
  });
});
