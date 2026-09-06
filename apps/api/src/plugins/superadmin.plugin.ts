import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';

/**
 * Decora `app.requireSuperadmin`: exige autenticación previa (`app.authenticate`)
 * y verifica contra `platform_admins` (vía `app.is_superadmin()`, SECURITY
 * DEFINER, ver packages/db/migrations/0007_rls_functions.sql). No depende de
 * ningún claim del JWT (que no lleva ese dato): siempre consulta la base de
 * datos, igual que `app.requireOrg` para membresías de organización.
 */
async function superadminPluginImpl(app: FastifyInstance): Promise<void> {
  app.decorate('requireSuperadmin', async function requireSuperadmin(request: FastifyRequest): Promise<void> {
    if (!request.userId) {
      throw new UnauthorizedError();
    }
    const { rows } = await app.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
      return tx.query<{ is_superadmin: boolean }>('select app.is_superadmin() as is_superadmin');
    });
    if (!rows[0]?.is_superadmin) {
      throw new ForbiddenError('Esta acción requiere privilegios de superadmin de plataforma');
    }
    request.isSuperadmin = true;
  });
}

export const superadminPlugin = fp(superadminPluginImpl, { name: 'superadmin-plugin' });
