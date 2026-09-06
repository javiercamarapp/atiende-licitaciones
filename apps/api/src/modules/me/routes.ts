import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError } from '../../lib/errors.js';

const meSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  fullName: z.string().nullable(),
});

export async function meRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/me',
    { preHandler: [app.authenticate], schema: { response: { 200: meSchema } } },
    async (request) => {
      const userId = request.userId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        return tx.query<{ id: string; email: string; full_name: string | null }>(
          'select id, email, full_name from users where id = $1',
          [userId]
        );
      });
      const user = rows[0];
      if (!user) throw new NotFoundError('Usuario no encontrado');
      return { id: user.id, email: user.email, fullName: user.full_name };
    }
  );
}
