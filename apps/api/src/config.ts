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
  };
}
