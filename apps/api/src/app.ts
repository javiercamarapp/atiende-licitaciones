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
import { auditLogRoutes } from './modules/audit/routes.js';
import { getRateLimitSettings } from './lib/rate-limit-settings.js';
import { expedienteDocumentsRoutes } from './modules/expediente/documents.routes.js';
import { expedienteProposalRoutes } from './modules/expediente/proposal.routes.js';
import { expedienteChecklistRoutes } from './modules/expediente/checklist.routes.js';
import { expedienteApprovalRoutes } from './modules/expediente/approval.routes.js';
import { expedientePackageRoutes } from './modules/expediente/package.routes.js';
import { expedienteSubmissionRoutes } from './modules/expediente/submission.routes.js';
import { expedientePostAwardRoutes } from './modules/expediente/post-award.routes.js';
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
  app.decorate('rateLimitSettings', getRateLimitSettings(options.config.rateLimitProfile));

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
  //
  // Ronda 4 (bug real encontrado por apps/web, docs/logs/web-ronda3.log):
  // sin una lista explícita de `methods`, `@fastify/cors` respondía el
  // preflight con `access-control-allow-methods: GET,HEAD,POST` -- sin PUT,
  // PATCH ni DELETE -- bloqueando en el propio navegador (antes de tocar el
  // servidor) cualquier escritura real que use esos métodos en cualquier
  // despliegue donde `apps/web`/`apps/api` vivan en orígenes distintos
  // (típico incluso en desarrollo local con puertos separados). `allowedHeaders`
  // también se declara explícito: sin él, un preflight que pide
  // `Authorization`/`X-Org-Id`/`Idempotency-Key` (las únicas cabeceras
  // "custom" que esta API exige, ver README) dependía del comportamiento
  // por defecto del plugin (reflejar `Access-Control-Request-Headers`), que
  // funciona pero no es explícito ni documentado -- aquí se fija la lista
  // real. `exposedHeaders` expone las cabeceras de límite de tasa
  // (`X-RateLimit-*`/`Retry-After`, ver `@fastify/rate-limit` más abajo):
  // sin `Access-Control-Expose-Headers`, JS en un origen cruzado no puede
  // LEER esas cabeceras aunque la respuesta las traiga (no están en la
  // lista de cabeceras "seguras" por defecto del navegador) -- rompiendo el
  // backoff real de `apps/web` (`src/lib/api/http.ts`, "reintento de 429
  // con backoff respetando Retry-After") en cualquier despliegue cross-origin.
  await app.register(cors, {
    origin: options.config.corsOrigins.length > 0 ? options.config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id', 'Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-request-id'],
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

  // Límite global por IP (protección base, hook `onRequest` -- antes de
  // cualquier autenticación, así que solo puede depender de la IP: usar
  // `X-Org-Id`/`Authorization` aquí sin verificar permitiría a un atacante
  // esquivar el límite rotándolos libremente). Rutas sensibles como
  // `/auth/login` declaran su propio override más estricto por ruta (ver
  // `modules/auth/routes.ts`); acciones de aprobación cross-tenant sensibles
  // (`/agents/tool-calls/:id/approve|deny`, `/admin/tool-calls/:id/approve|deny`)
  // declaran el suyo con `hook: 'preHandler'` (después de
  // `app.authenticate`/`app.requireOrg`/`app.requireSuperadmin`, así que SÍ
  // pueden aislar el "presupuesto" de cada organización/superadmin del de
  // las demás -- ver `rateLimitSettings.sensitiveAction` y
  // `lib/rate-limit-settings.ts`). Ronda 4: los límites concretos por
  // "tier" (global/auth/sensitiveAction) y el perfil `RATE_LIMIT_PROFILE`
  // (solo para pruebas E2E) viven en ese módulo, no como números mágicos
  // aquí. La tabla `rate_limits` de packages/db sigue existiendo para un
  // futuro límite persistido entre procesos (hoy en memoria, por proceso).
  await app.register(rateLimit, {
    global: true,
    max: app.rateLimitSettings.global.max,
    timeWindow: app.rateLimitSettings.global.timeWindow,
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
  // Ronda 4: bitácora de auditoría por organización (reviewer/admin/owner).
  // La contraparte de plataforma (`GET /admin/audit-log`, superadmin) vive
  // dentro de `adminRoutes` (prefijo `/admin`), no aquí.
  await app.register(auditLogRoutes);

  // E6-E9/E11 (ronda 3): expediente de participación real sobre
  // @atiende/expediente. Todas bajo /expediente/... para no colisionar con
  // las rutas existentes de /tenders/:id (ronda 1/2).
  await app.register(expedienteDocumentsRoutes, { prefix: '/expediente' });
  await app.register(expedienteProposalRoutes, { prefix: '/expediente' });
  await app.register(expedienteChecklistRoutes, { prefix: '/expediente' });
  await app.register(expedienteApprovalRoutes, { prefix: '/expediente' });
  await app.register(expedientePackageRoutes, { prefix: '/expediente' });
  await app.register(expedienteSubmissionRoutes, { prefix: '/expediente' });
  await app.register(expedientePostAwardRoutes, { prefix: '/expediente' });

  return app;
}
