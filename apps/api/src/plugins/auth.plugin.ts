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
}

export const authPlugin = fp(authPluginImpl, { name: 'auth-plugin' });
