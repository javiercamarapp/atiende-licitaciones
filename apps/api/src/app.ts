import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform } from 'fastify-type-provider-zod';
import type { DbClient } from '@atiende/db';
import { applyMigrations } from '@atiende/db';
import type { MailProvider } from '@atiende/mail';
import type { WhatsAppProvider } from '@atiende/whatsapp';
import type { AppConfig } from './config.js';
import { authPlugin } from './plugins/auth.plugin.js';
import { superadminPlugin } from './plugins/superadmin.plugin.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { correlationIdPlugin } from './plugins/correlation-id.plugin.js';
import { metricsPlugin } from './plugins/metrics.plugin.js';
import { healthRoutes } from './modules/health/routes.js';
import { authRoutes } from './modules/auth/routes.js';
import { googleAuthRoutes } from './modules/auth/google/routes.js';
import { googleUnlinkRoutes } from './modules/auth/google/unlink.routes.js';
import { authMailRoutes } from './modules/auth/mail.routes.js';
import { sessionsRoutes } from './modules/auth/sessions.routes.js';
import { authPasswordRoutes } from './modules/auth/password.routes.js';
import { twofaRoutes } from './modules/twofa/routes.js';
import { legalRoutes } from './modules/legal/routes.js';
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
import { buildMailServiceFromEnv } from './lib/mail/env.js';
import { buildWhatsAppProviderFromEnv } from './lib/mail/whatsapp-channel.js';
import { PendingMailTracker } from './lib/mail/pending.js';
import { mailRoutes } from './modules/mail/routes.js';
import { mailWebhookRoutes } from './modules/mail/webhook.routes.js';
import { publicContactRoutes } from './modules/public/contact.routes.js';
import { expedienteDocumentsRoutes } from './modules/expediente/documents.routes.js';
import { expedienteProposalRoutes } from './modules/expediente/proposal.routes.js';
import { expedienteChecklistRoutes } from './modules/expediente/checklist.routes.js';
import { expedienteApprovalRoutes } from './modules/expediente/approval.routes.js';
import { expedientePackageRoutes } from './modules/expediente/package.routes.js';
import { expedienteSubmissionRoutes } from './modules/expediente/submission.routes.js';
import { expedientePostAwardRoutes } from './modules/expediente/post-award.routes.js';
import { expedienteContractRoutes } from './modules/expediente/contract.routes.js';
import { expedienteInconformidadRoutes } from './modules/expediente/inconformidad.routes.js';
import { expedienteFalloAutopsyRoutes } from './modules/expediente/fallo-autopsy.routes.js';
import { expedienteRenewalRadarRoutes } from './modules/expediente/renewal-radar.routes.js';
import { MAX_BASE64_LENGTH } from './lib/storage.js';
import './types.js';

export interface BuildAppOptions {
  db: DbClient;
  config: AppConfig;
  logger?: boolean;
  /** REQ-181..195: `MailProvider` explícito en vez del que resuelve `MAIL_PROVIDER` -- ver `lib/mail/env.ts`. */
  mailProvider?: MailProvider;
  /** Canal ADICIONAL de WhatsApp: `WhatsAppProvider` explícito en vez del que resuelve `WHATSAPP_PROVIDER` -- ver `lib/mail/whatsapp-channel.ts`, misma costura de inyección que `mailProvider`. */
  whatsappProvider?: WhatsAppProvider;
}

// AE-15 (docs/auditoria-2/api-expediente-reverificacion.md, BAJA): el
// `bodyLimit` por defecto de Fastify (1 MiB) es INCOHERENTE con el límite
// de subida "~22MB" que `lib/storage.ts` (`MAX_BASE64_LENGTH`, base64) y el
// README documentan como soportado -- cualquier subida por encima de 1 MiB
// se rechazaba con 413 mucho antes de llegar al chequeo explícito de
// `decodeBase64Content` (422 "Archivo demasiado grande"). Se fija el
// `bodyLimit` real de Fastify por encima de `MAX_BASE64_LENGTH` (con margen
// para el resto del JSON -- filename, metadatos, etc.) para que el límite
// de verdad sea el documentado, con un mensaje explícito (422) en vez de
// que Fastify corte antes con un 413 genérico para cargas legítimas.
const BODY_LIMIT_BYTES = MAX_BASE64_LENGTH + 2_000_000;

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? crypto.randomUUID(),
    bodyLimit: BODY_LIMIT_BYTES,
  });

  app.decorate('db', options.db);
  app.decorate('config', options.config);
  app.decorate('rateLimitSettings', getRateLimitSettings(options.config.rateLimitProfile));
  // REQ-181..195: MailService único del proceso -- ver lib/mail/env.ts.
  const builtMail = buildMailServiceFromEnv({
    db: options.db,
    mailLinkSecret: options.config.mailLinkSecret,
    provider: options.mailProvider,
  });
  app.decorate('mail', builtMail.mail);
  app.decorate('mailProvider', builtMail.provider);
  // Canal ADICIONAL de WhatsApp -- ver lib/mail/whatsapp-channel.ts. Mismo
  // criterio que MailProvider: sin WHATSAPP_PROVIDER=meta (o sin credenciales
  // reales de Meta, que este entorno todavía no tiene) degrada a
  // CaptureProvider, nunca sale a Internet por accidente.
  app.decorate('whatsapp', buildWhatsAppProviderFromEnv({ provider: options.whatsappProvider }));
  const pendingMail = new PendingMailTracker();
  app.decorate('pendingMail', pendingMail);
  app.decorate('waitForPendingMail', () => pendingMail.wait());
  // Cierre ordenado: nunca dejar a medias la escritura del outbox de un
  // correo disparado sin `await` (ver lib/mail/pending.ts).
  app.addHook('onClose', async () => {
    await pendingMail.wait();
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  if (options.config.autoMigrate) {
    await applyMigrations(options.db);
  }

  await app.register(errorHandlerPlugin);
  await app.register(correlationIdPlugin);
  await app.register(authPlugin);
  await app.register(superadminPlugin);
  await app.register(metricsPlugin);

  // Cabeceras de seguridad (helmet).
  //
  // WI-01 (docs/auditoria-2/web-integrado.md): `contentSecurityPolicy:
  // false` dejaba esta API sin NINGÚN CSP -- el razonamiento original ("solo
  // sirve JSON, un CSP no aporta") ignoraba que `/docs/json` sí devuelve
  // contenido consumible por un navegador, y que un CSP explícito es
  // defensa en profundidad real incluso para una API JSON pura (mitiga que
  // una respuesta alguna vez se sirva/interprete como HTML por un bug de
  // negociación de contenido, o que un futuro endpoint sirva HTML sin que
  // alguien recuerde revisar este registro). Se activa un CSP restrictivo
  // real: `default-src`/`script-src 'self'` (esta API nunca sirve ni
  // ejecuta JS de terceros), `connect-src 'self'` + los orígenes del
  // frontend configurados en `CORS_ORIGINS` (el mismo origen que YA está
  // autorizado a llamar a esta API vía CORS, ver arriba -- no se introduce
  // una variable de entorno nueva), `frame-ancestors 'none'` (nunca debe
  // poder embeberse en un iframe de ningún origen, ni siquiera el propio --
  // más estricto que `X-Frame-Options: SAMEORIGIN`, que helmet ya fija por
  // defecto y se conserva como respaldo para navegadores viejos sin
  // soporte de CSP nivel 2) y `object-src 'none'` (sin plugins/objetos
  // embebidos). `X-Content-Type-Options`/`Referrer-Policy` ya los fija
  // helmet por defecto (`nosniff`/`no-referrer`, confirmado en
  // `test/audit-api05-security-headers.test.ts`); `Permissions-Policy` NO
  // tiene middleware propio en `helmet` 8.x (lo retiró por no estar
  // estandarizado de forma estable) -- se fija a mano justo debajo, en un
  // hook `onSend` que corre para TODA respuesta (incluidas 4xx/5xx).
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'", ...options.config.corsOrigins],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  });

  // WI-01: Permissions-Policy explícito (deshabilita APIs de navegador que
  // esta API JSON nunca necesita) -- sin esto, un navegador aplicaría sus
  // valores por defecto (permitir todo al propio origen), un margen que no
  // aporta nada aquí y sí una superficie defensiva innecesaria.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    return payload;
  });

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
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Org-Id', 'Idempotency-Key', 'X-Request-Id', 'X-Correlation-Id', 'X-Step-Up'],
    exposedHeaders: ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-request-id', 'x-correlation-id'],
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Atiende Licitaciones API',
        description:
          'API de la plataforma Atiende Licitaciones (ronda 5: post-adjudicación estructurado + calendario oficial, procedencia vinculante, correlation_id de extremo a extremo, 2FA/step-up en aprobaciones económicas, aviso de privacidad).',
        version: '0.5.0',
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
  await app.register(legalRoutes);
  await app.register(authRoutes, { prefix: '/auth' });
  // REQ-172..180: login/registro con Google (OIDC), junto al método
  // email+contraseña existente, sin reemplazarlo.
  await app.register(googleAuthRoutes, { prefix: '/auth/google' });
  // E19/E21 (docs/BACKLOG.md): desvincular la identidad de Google de la
  // propia cuenta -- registrada aparte de googleAuthRoutes porque exige
  // sesión autenticada (app.authenticate), a diferencia de start/callback/
  // verify-2fa (login), que son anónimas.
  await app.register(googleUnlinkRoutes, { prefix: '/auth/google' });
  // REQ-181..195: verificación de correo y recuperación de contraseña
  // (rutas ANÓNIMAS, ver modules/auth/mail.routes.ts).
  await app.register(authMailRoutes, { prefix: '/auth' });
  await app.register(twofaRoutes, { prefix: '/auth' });
  // E21 (docs/BACKLOG.md, segunda mitad): sesiones activas propias
  // (listar/cerrar una/cerrar todas menos la actual) y cambio de
  // contraseña autenticado con step-up.
  await app.register(sessionsRoutes, { prefix: '/auth' });
  await app.register(authPasswordRoutes, { prefix: '/auth' });
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

  // REQ-181..195 (correo transaccional): preferencias de notificación y baja
  // de un clic (RFC 8058), webhook de entrega/rebote del proveedor y
  // formulario de contacto público. Los tres son PÚBLICOS o
  // semi-públicos por naturaleza (un cliente de correo hace el POST de baja
  // sin sesión; el proveedor firma su webhook con Svix; el formulario de
  // contacto es anónimo) -- ver cada módulo para su anti-abuso.
  await app.register(mailRoutes, { prefix: '/mail' });
  await app.register(mailWebhookRoutes, { prefix: '/webhooks/mail' });
  await app.register(publicContactRoutes, { prefix: '/public' });

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
  // Ronda 6: REQ-051 (máquina de estados del contrato) + REQ-052 (extracción
  // del contrato firmado), REQ-053 (redactor de inconformidades, borrador),
  // REQ-054 (autopsia del fallo), REQ-055 (radar de renovaciones).
  await app.register(expedienteContractRoutes, { prefix: '/expediente' });
  await app.register(expedienteInconformidadRoutes, { prefix: '/expediente' });
  await app.register(expedienteFalloAutopsyRoutes, { prefix: '/expediente' });
  await app.register(expedienteRenewalRadarRoutes, { prefix: '/expediente' });

  return app;
}
