import type { DbClient } from '@atiende/db';
import type { OrgRole, OicRole } from '@atiende/db';
import type { MailProvider, MailService } from '@atiende/mail';
import type { WhatsAppProvider } from '@atiende/whatsapp';
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
    /** Canal ADICIONAL de WhatsApp (`lib/mail/whatsapp-channel.ts`), decorado en `src/app.ts` -- ver ese archivo para el porqué de "adicional, nunca en reemplazo del correo". */
    whatsapp: WhatsAppProvider;
    /** REQ-181..195: envíos disparados sin `await` (`lib/mail/pending.ts`). */
    pendingMail: PendingMailTracker;
    /** REQ-181..195: espera a que terminen los envíos en segundo plano (cierre ordenado y pruebas de integración). */
    waitForPendingMail: () => Promise<void>;
    /** Límites de tasa resueltos para el perfil activo (`config.rateLimitProfile`), ver `lib/rate-limit-settings.ts`. */
    rateLimitSettings: RateLimitSettings;
    authenticate: (request: FastifyRequest) => Promise<void>;
    requireOrg: (request: FastifyRequest) => Promise<void>;
    /** REQ-060: paralelo de `requireOrg`, pero para el lado comprador (OIC).
     *  Físicamente separado de `requireOrg` a propósito (ver
     *  `plugins/auth.plugin.ts`) -- ninguno de los dos puede resolver una
     *  organización del otro lado, ni siquiera por error de programación,
     *  porque cada uno solo sabe consultar su propia tabla de membresías. */
    requireOicOrg: (request: FastifyRequest) => Promise<void>;
    requireSuperadmin: (request: FastifyRequest) => Promise<void>;
    requirePlatformApiKey: (request: FastifyRequest) => Promise<void>;
  }

  interface FastifyRequest {
    userId?: string;
    orgId?: string;
    orgRole?: OrgRole;
    isSuperadmin?: boolean;
    /** REQ-060: organización activa del lado comprador (OIC), resuelta por `requireOicOrg`. */
    oicOrgId?: string;
    /** REQ-060: rol OIC del actor en `oicOrgId`, resuelto por `requireOicOrg`. */
    oicRole?: OicRole;
    /** REQ-171: id de correlación de negocio (heredado de `X-Correlation-Id` o generado), ver `plugins/correlation-id.plugin.ts`. */
    correlationId?: string;
  }
}
