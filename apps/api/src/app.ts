import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { DbClient } from '@atiende/db';
import { applyMigrations } from '@atiende/db';
import type { AppConfig } from './config.js';
import { authPlugin } from './plugins/auth.plugin.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { healthRoutes } from './modules/health/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { organizationRoutes } from './modules/organizations/routes.js';
import { meRoutes } from './modules/me/routes.js';
import './types.js';

export interface BuildAppOptions {
  db: DbClient;
  config: AppConfig;
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
  });

  app.decorate('db', options.db);
  app.decorate('config', options.config);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  if (options.config.autoMigrate) {
    await applyMigrations(options.db);
  }

  await app.register(errorHandlerPlugin);
  await app.register(authPlugin);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Atiende Licitaciones API',
        description: 'API de la plataforma Atiende Licitaciones (ronda 1: auth, organizaciones, salud).',
        version: '0.1.0',
      },
    },
  });
  app.get('/docs/json', { schema: { hide: true } }, async () => app.swagger());

  // Límite global por IP (protección base). Además, rutas sensibles como
  // /auth/login declaran su propio override más estricto por ruta (ver
  // modules/auth/routes.ts). Nota de alcance: un límite verdaderamente por
  // organización/usuario requeriría resolver esa identidad en `onRequest`
  // (antes de los preHandlers de autenticación), lo que ronda 1 no hace;
  // queda documentado como pendiente en apps/api/README.md. La tabla
  // `rate_limits` de packages/db ya existe para ese uso futuro.
  await app.register(rateLimit, {
    global: true,
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(organizationRoutes, { prefix: '/organizations' });
  await app.register(meRoutes);

  return app;
}
