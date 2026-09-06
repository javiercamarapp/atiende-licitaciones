export interface AppConfig {
  port: number;
  jwtSecret: string;
  databaseUrl?: string;
  nodeEnv: string;
  autoMigrate: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error(
      'JWT_SECRET no definido o demasiado corto (mínimo 16 caracteres). Ver apps/api/.env.example.'
    );
  }
  return {
    port: Number(env.PORT ?? 3000),
    jwtSecret,
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV ?? 'development',
    autoMigrate: env.SKIP_MIGRATIONS !== 'true',
  };
}
