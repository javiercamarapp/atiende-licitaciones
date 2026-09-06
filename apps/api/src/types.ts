import type { DbClient } from '@atiende/db';
import type { OrgRole } from '@atiende/db';
import type { AppConfig } from './config.js';
import type { RateLimitSettings } from './lib/rate-limit-settings.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DbClient;
    config: AppConfig;
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
  }
}
