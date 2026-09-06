import type { DbClient } from '@atiende/db';
import type { OrgRole } from '@atiende/db';
import type { MailProvider, MailService } from '@atiende/mail';
import type { AppConfig } from './config.js';
import type { PendingMailTracker } from './lib/mail/pending.js';
import type { RateLimitSettings } from './lib/rate-limit-settings.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DbClient;
    config: AppConfig;
    /** REQ-181..195: instancia única de `MailService` (`lib/mail/env.ts`), decorada en `src/app.ts`. */
    mail: MailService;
    /** REQ-181..195: el `MailProvider` que quedó configurado -- ver `BuiltMailService.provider`. */
    mailProvider: MailProvider;
    /** REQ-181..195: envíos disparados sin `await` (`lib/mail/pending.ts`). */
    pendingMail: PendingMailTracker;
    /** REQ-181..195: espera a que terminen los envíos en segundo plano (cierre ordenado y pruebas de integración). */
    waitForPendingMail: () => Promise<void>;
    /** Límites de tasa resueltos para el perfil activo (`config.rateLimitProfile`), ver `lib/rate-limit-settings.ts`. */
    rateLimitSettings: RateLimitSettings;
    authenticate: (request: FastifyRequest) => Promise<void>;
    requireOrg: (request: FastifyRequest) => Promise<void>;
    requireSuperadmin: (request: FastifyRequest) => Promise<void>;
    requirePlatformApiKey: (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    userId?: string;
    orgId?: string;
    orgRole?: OrgRole;
    isSuperadmin?: boolean;
    /** REQ-171: id de correlación de negocio (heredado de `X-Correlation-Id` o generado), ver `plugins/correlation-id.plugin.ts`. */
    correlationId?: string;
  }
}
