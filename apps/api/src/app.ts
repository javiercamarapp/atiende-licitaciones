import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { DbClient } from '@atiende/db';
import { applyMigrations } from '@atiende/db';
import type { AppConfig } from './config.js';
import { authPlugin } from './plugins/auth.plugin.js';
import { superadminPlugin } from './plugins/superadmin.plugin.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { metricsPlugin } from './plugins/metrics.plugin.js';
import { healthRoutes } from './modules/health/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { organizationRoutes } from './modules/organizations/routes.js';
import { meRoutes } from './modules/me/routes.js';
import { companyRoutes } from './modules/company/routes.js';
import { tenderRoutes } from './modules/tenders/routes.js';
import { internalIngestRoutes } from './modules/tenders/internal-ingest.routes.js';
import { matchingRoutes } from './modules/matching/routes.js';
import { goNoGoRoutes } from './modules/matching/go-no-go.routes.js';
import { agentRoutes } from './modules/agents/routes.js';
import { adminRoutes } from './modules/admin/routes.js';
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
  await app.register(superadminPlugin);
  await app.register(metricsPlugin);

  // Cabeceras de seguridad básicas (helmet). `contentSecurityPolicy: false`
  // porque esta API no sirve HTML/frontend (solo JSON); un CSP pensado para
  // páginas no aporta aquí y puede interferir con /docs (Swagger UI si se
  // añade luego). El resto de cabeceras (X-Content-Type-Options,
  // X-Frame-Options, Strict-Transport-Security, etc.) sí aplican.
  await app.register(helmet, { contentSecurityPolicy: false });

  // CORS configurable por entorno (CORS_ORIGINS, ver .env.example). Sin
  // orígenes configurados, ninguna petición cross-site con credenciales es
  // aceptada (falla cerrado); "*" no es válido junto a credentials:true así
  // que el arreglo vacío es el valor seguro por defecto.
  await app.register(cors, {
    origin: options.config.corsOrigins.length > 0 ? options.config.corsOrigins : false,
    credentials: true,
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Atiende Licitaciones API',
        description:
          'API de la plataforma Atiende Licitaciones (ronda 2: auth, organizaciones, perfil de empresa, convocatorias, matching, agentes, back office).',
        version: '0.2.0',
      },
    },
    // Imprescindible con fastify-type-provider-zod: sin este `transform`,
    // @fastify/swagger no sabe convertir un esquema `params`/`querystring`
    // definido con zod a JSON Schema válido y `GET /docs/json` lanza un 500
    // ("Cannot read properties of null (reading 'examples')") en cuanto
    // CUALQUIER ruta declara `params`/`querystring` con zod (verificado:
    // afecta incluso al ejemplo más simple, `z.object({ foo: z.string() })`
    // en una ruta de una sola palabra). `body`/`response` funcionaban sin
    // esto por una vía de conversión distinta, lo que ocultó el problema
    // hasta regenerar el OpenAPI con rutas que sí usan params/querystring.
    transform: jsonSchemaTransform,
  });
  // API-06 (docs/auditoria-1/db-api.md): el esquema OpenAPI completo era
  // accesible sin autenticación. Se exige una sesión válida (cualquier
  // usuario autenticado, no necesariamente superadmin: es documentación
  // técnica de la propia API, no datos de tenant ni de back office).
  app.get('/docs/json', { schema: { hide: true }, preHandler: [app.authenticate] }, async () => app.swagger());

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
  await app.register(companyRoutes, { prefix: '/company' });
  await app.register(tenderRoutes, { prefix: '/tenders' });
  await app.register(internalIngestRoutes, { prefix: '/internal/tenders' });
  await app.register(matchingRoutes, { prefix: '/matching' });
  await app.register(goNoGoRoutes, { prefix: '/tenders' });
  await app.register(agentRoutes, { prefix: '/agents' });
  await app.register(adminRoutes, { prefix: '/admin' });

  return app;
}
