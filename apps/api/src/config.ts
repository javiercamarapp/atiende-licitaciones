export interface AppConfig {
  port: number;
  jwtSecret: string;
  databaseUrl?: string;
  nodeEnv: string;
  autoMigrate: boolean;
  /** Directorio local donde se guardan los archivos subidos (documentos de empresa, etc.). Nunca S3/objeto remoto en esta ronda. */
  storageDir: string;
  /** Orígenes permitidos para CORS, separados por coma. `*` deshabilita la restricción (solo recomendable en desarrollo). */
  corsOrigins: string[];
  /** Clave de API de plataforma para autenticar servicios internos (p.ej. apps/worker) contra `POST /internal/tenders/ingest`. */
  platformApiKey?: string;
  /**
   * Perfil de límites de tasa (`@fastify/rate-limit`, ver `lib/rate-limit-settings.ts`).
   * SIEMPRE `'default'` salvo que `RATE_LIMIT_PROFILE=e2e` esté definido
   * EXACTAMENTE así -- ronda 4 (docs/logs/api-ronda4.log): cualquier otro
   * valor (incluido no definir la variable, o `NODE_ENV=test`/`development`)
   * cae en `'default'`, nunca en `'e2e'`, para que una fuga de configuración
   * jamás relaje límites de producción por accidente. `'e2e'` existe
   * exclusivamente para que un harness de pruebas end-to-end (p.ej.
   * `apps/web` `scripts/e2e-full.mjs`) levante esta API con límites más
   * altos y no confunda un 429 real de una suite intensiva con un fallo de
   * producto (ver apps/web/README.md, bug de rate limit en
   * `docs/logs/web-ronda3.log`).
   */
  rateLimitProfile: 'default' | 'e2e';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error(
      'JWT_SECRET no definido o demasiado corto (mínimo 16 caracteres). Ver apps/api/.env.example.'
    );
  }
  const corsOriginsRaw = env.CORS_ORIGINS?.trim();
  const corsOrigins = corsOriginsRaw ? corsOriginsRaw.split(',').map((o) => o.trim()).filter(Boolean) : [];

  return {
    port: Number(env.PORT ?? 3000),
    jwtSecret,
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV ?? 'development',
    autoMigrate: env.SKIP_MIGRATIONS !== 'true',
    storageDir: env.STORAGE_DIR ?? '.data/storage',
    corsOrigins,
    platformApiKey: env.PLATFORM_API_KEY,
    // Comparación estricta: solo el literal 'e2e' activa el perfil elevado.
    rateLimitProfile: env.RATE_LIMIT_PROFILE === 'e2e' ? 'e2e' : 'default',
  };
}
