import { createDbClientFromEnv } from '@atiende/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await createDbClientFromEnv(process.env);
  const app = await buildApp({ db, config });

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error('Fallo al arrancar apps/api:', err);
  process.exit(1);
});
