import { applyMigrations, createDbClientFromEnv } from '@atiende/db';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { JobQueue } from './queue/job-queue.js';
import { Worker } from './queue/worker.js';
import { Scheduler } from './scheduler/scheduler.js';
import { loadScheduleConfig } from './scheduler/schedule-config.js';
import {
  buildDefaultConnectorRegistry,
  buildDefaultHttpClient,
  createDiscoverTendersHandler,
} from './handlers/discover-tenders.js';
import { createRunAgentHandler } from './handlers/run-agent.js';
import { TenderIngestClient } from './ingest/ingest-client.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  const db = await createDbClientFromEnv(process.env);
  if (config.autoMigrate) {
    await applyMigrations(db);
  }

  const queue = new JobQueue({ db });

  const ingestClient = new TenderIngestClient({
    baseUrl: config.apiBaseUrl,
    apiKey: config.platformApiKey,
  });

  const handlers = {
    discover_tenders: createDiscoverTendersHandler({
      db,
      registry: buildDefaultConnectorRegistry(),
      ingestClient,
      httpClient: buildDefaultHttpClient(),
    }),
    run_agent: createRunAgentHandler({ db }),
  };

  const worker = new Worker({
    queue,
    handlers,
    workerId: config.workerId,
    logger,
    pollIntervalMs: config.pollIntervalMs,
    leaseSeconds: config.leaseSeconds,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
  });

  const scheduler = new Scheduler({ queue, schedules: loadScheduleConfig(), logger });
  const stopScheduler = scheduler.start(config.pollIntervalMs * 10);

  worker.start();
  logger.info({ worker_id: config.workerId }, 'apps/worker arrancado');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'señal de apagado recibida: cierre ordenado en curso');
    stopScheduler();
    await worker.stop(config.shutdownTimeoutMs);
    await db.close();
    logger.info('apps/worker detenido de forma ordenada');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('Fallo al arrancar apps/worker:', err);
  process.exit(1);
});
