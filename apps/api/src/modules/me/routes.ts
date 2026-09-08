import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError } from '../../lib/errors.js';

/**
 * E19/E21 (docs/BACKLOG.md): `hasPassword`/`googleLinked` se añaden para
 * que `apps/web` (pantalla de Configuración/seguridad) sepa, sin adivinar,
 * qué métodos de acceso tiene la cuenta -- p. ej. para decidir si mostrar
 * "Desvincular Google" (exige `hasPassword`, ver
 * `modules/auth/google/unlink.routes.ts`) o "Cambiar contraseña" (exige
 * `hasPassword`, ver `modules/auth/password.routes.ts`). Aditivo y hacia
 * atrás compatible: ningún consumidor existente de `GET /me` dejaba de
 * funcionar por dos campos nuevos.
 */
const meSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  fullName: z.string().nullable(),
  hasPassword: z.boolean(),
  googleLinked: z.boolean(),
});

export async function meRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/me',
    { preHandler: [app.authenticate], schema: { response: { 200: meSchema } } },
    async (request) => {
      const userId = request.userId!;
      const { userRows, identityRows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        const userRows = await tx.query<{ id: string; email: string; full_name: string | null; password_hash: string | null }>(
          'select id, email, full_name, password_hash from users where id = $1',
          [userId]
        );
        const identityRows = await tx.query<{ id: string }>(
          "select id from user_identities where user_id = $1 and provider = 'google'",
          [userId]
        );
        return { userRows: userRows.rows, identityRows: identityRows.rows };
      });
      const user = userRows[0];
      if (!user) throw new NotFoundError('Usuario no encontrado');
      return {
        id: user.id,
        email: user.email,
        fullName: user.full_name,
        hasPassword: user.password_hash !== null,
        googleLinked: identityRows.length > 0,
      };
    }
  );
}
