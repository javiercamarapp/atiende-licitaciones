import type { DbClient } from '@atiende/db';
import type { OrgRole } from '@atiende/db';
import type { AppConfig } from './config.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: DbClient;
    config: AppConfig;
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
