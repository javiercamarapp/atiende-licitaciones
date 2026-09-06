import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('usa valores por defecto razonables cuando el entorno está vacío', () => {
    const config = loadConfig({});
    expect(config.databaseUrl).toBeUndefined();
    expect(config.nodeEnv).toBe('development');
    expect(config.autoMigrate).toBe(true);
    expect(config.workerId).toMatch(/^worker-/);
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.leaseSeconds).toBe(60);
    expect(config.heartbeatIntervalMs).toBe(15_000);
    expect(config.maxConcurrentJobs).toBe(1);
    expect(config.shutdownTimeoutMs).toBe(30_000);
    expect(config.logLevel).toBe('info');
    expect(config.apiBaseUrl).toBe('http://localhost:3000');
    expect(config.platformApiKey).toBeUndefined();
    expect(config.openaiApiKey).toBeUndefined();
  });

  it('lee todas las variables de entorno relevantes cuando están definidas', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x',
      NODE_ENV: 'production',
      SKIP_MIGRATIONS: 'true',
      WORKER_ID: 'worker-fijo',
      WORKER_POLL_INTERVAL_MS: '2500',
      WORKER_LEASE_SECONDS: '90',
      WORKER_HEARTBEAT_INTERVAL_MS: '5000',
      WORKER_MAX_CONCURRENT_JOBS: '3',
      WORKER_SHUTDOWN_TIMEOUT_MS: '10000',
      LOG_LEVEL: 'debug',
      API_BASE_URL: 'https://api.atiende.mx',
      PLATFORM_API_KEY: 'clave-secreta',
      OPENAI_API_KEY: 'sk-test',
    });
    expect(config.databaseUrl).toBe('postgres://x');
    expect(config.nodeEnv).toBe('production');
    expect(config.autoMigrate).toBe(false); // SKIP_MIGRATIONS=true invierte la bandera
    expect(config.workerId).toBe('worker-fijo');
    expect(config.pollIntervalMs).toBe(2500);
    expect(config.leaseSeconds).toBe(90);
    expect(config.heartbeatIntervalMs).toBe(5000);
    expect(config.maxConcurrentJobs).toBe(3);
    expect(config.shutdownTimeoutMs).toBe(10_000);
    expect(config.logLevel).toBe('debug');
    expect(config.apiBaseUrl).toBe('https://api.atiende.mx');
    expect(config.platformApiKey).toBe('clave-secreta');
    expect(config.openaiApiKey).toBe('sk-test');
  });

  it('un valor numérico inválido cae al default en vez de propagar NaN', () => {
    const config = loadConfig({ WORKER_POLL_INTERVAL_MS: 'no-es-un-numero' });
    expect(config.pollIntervalMs).toBe(1000);
  });
});
