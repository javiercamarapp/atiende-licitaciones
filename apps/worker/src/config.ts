export interface WorkerConfig {
  databaseUrl?: string;
  nodeEnv: string;
  autoMigrate: boolean;
  workerId: string;
  pollIntervalMs: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  maxConcurrentJobs: number;
  shutdownTimeoutMs: number;
  logLevel: string;

  /** Base URL de apps/api (contrato interno de ingesta, ver src/ingest/ingest-client.ts). */
  apiBaseUrl: string;
  /**
   * Clave compartida worker<->api para el endpoint interno
   * `POST /internal/tenders/ingest` (cabecera `X-Platform-Api-Key`). Mismo
   * nombre de variable que usa `apps/api` (`PLATFORM_API_KEY`, ver
   * `apps/api/src/config.ts`/`.env.example`) para que ambos procesos
   * compartan el mismo secreto sin traducción de nombres.
   */
  platformApiKey?: string;

  /** Si está definido, run_agent usa OpenAIResponsesProvider real; si no, FakeProvider (ver README §Pendientes). */
  openaiApiKey?: string;

  /**
   * Base pública de `apps/web`, MISMA variable y MISMO valor por defecto que
   * `apps/api` (`PUBLIC_URL`, ver `apps/api/src/config.ts`) -- usada por el
   * handler `send_agent_alert` (REQ-181, plantilla `deadline-reminder`) para
   * armar el CTA del correo y el enlace de preferencias, nunca para firmar
   * enlaces (ver `mail/build-mail-service.ts`: este proceso no tiene
   * `linkSigner`).
   */
  publicUrl: string;
  /** MISMA variable y MISMO valor por defecto que `apps/api` (`MAIL_FROM`, ver `apps/api/src/config.ts`). */
  supportEmail: string;
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV ?? 'development',
    autoMigrate: env.SKIP_MIGRATIONS !== 'true',
    workerId: env.WORKER_ID ?? `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    pollIntervalMs: num(env, 'WORKER_POLL_INTERVAL_MS', 1000),
    leaseSeconds: num(env, 'WORKER_LEASE_SECONDS', 60),
    heartbeatIntervalMs: num(env, 'WORKER_HEARTBEAT_INTERVAL_MS', 15_000),
    maxConcurrentJobs: num(env, 'WORKER_MAX_CONCURRENT_JOBS', 1),
    shutdownTimeoutMs: num(env, 'WORKER_SHUTDOWN_TIMEOUT_MS', 30_000),
    logLevel: env.LOG_LEVEL ?? 'info',
    apiBaseUrl: env.API_BASE_URL ?? 'http://localhost:3000',
    platformApiKey: env.PLATFORM_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    publicUrl: env.PUBLIC_URL ?? 'https://app.atiende.mx',
    supportEmail: env.MAIL_FROM ?? 'soporte@atiende.mx',
  };
}
