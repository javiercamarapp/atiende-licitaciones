import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { verifyAccessToken } from '../lib/jwt.js';
import { UnauthorizedError, ForbiddenError } from '../lib/errors.js';

/** Decora `app.authenticate`: exige `Authorization: Bearer <access token>`. */
async function authPluginImpl(app: FastifyInstance): Promise<void> {
  app.decorate('authenticate', async function authenticate(request: FastifyRequest): Promise<void> {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedError('Falta encabezado Authorization: Bearer <token>');
    }
    const token = header.slice('Bearer '.length).trim();
    try {
      const payload = await verifyAccessToken(app.config.jwtSecret, token);
      request.userId = payload.sub;
    } catch {
      throw new UnauthorizedError('Token de acceso inválido o expirado');
    }
  });

  app.decorate('requireOrg', async function requireOrg(request: FastifyRequest): Promise<void> {
    if (!request.userId) {
      throw new UnauthorizedError();
    }
    const orgId = request.headers['x-org-id'];
    if (!orgId || typeof orgId !== 'string') {
      throw new ForbiddenError('Falta encabezado X-Org-Id');
    }
    const { rows } = await app.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ role: string | null }>('select app.membership_role($1, $2) as role', [
        orgId,
        request.userId,
      ]);
    });
    const role = rows[0]?.role;
    if (!role) {
      throw new ForbiddenError('No eres miembro de esta organización');
    }
    request.orgId = orgId;
    request.orgRole = role as FastifyRequest['orgRole'];
  });

  // Autenticación de servicios internos (p.ej. apps/worker) vía cabecera
  // `X-Platform-Api-Key` comparada contra `config.platformApiKey`. Falla
  // CERRADO: si la variable de entorno no está configurada, NINGUNA
  // solicitud pasa (nunca "sin clave configurada = abierto").
  app.decorate('requirePlatformApiKey', async function requirePlatformApiKey(request: FastifyRequest): Promise<void> {
    const expected = app.config.platformApiKey;
    if (!expected) {
      throw new ForbiddenError('PLATFORM_API_KEY no está configurada: la ingesta interna está deshabilitada');
    }
    const provided = request.headers['x-platform-api-key'];
    if (!provided || typeof provided !== 'string' || provided !== expected) {
      throw new UnauthorizedError('Clave de API de plataforma inválida o ausente');
    }
  });
}

export const authPlugin = fp(authPluginImpl, { name: 'auth-plugin' });
