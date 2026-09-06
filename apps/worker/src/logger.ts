import pino from 'pino';

export type Logger = pino.Logger;

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

/**
 * Logger raíz del worker. Cada job/ejecución debe derivar un logger hijo con
 * `logger.child({ job_id, correlation_id })` (ver `queue/worker.ts`) para que
 * toda línea emitida durante el procesamiento de ese job quede correlacionada
 * sin tener que pasar el id manualmente a cada `log.info(...)`.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? 'info';
  return pino({
    level,
    base: { app: 'atiende-worker' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
