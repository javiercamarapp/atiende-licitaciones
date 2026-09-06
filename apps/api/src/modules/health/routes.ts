import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  app.get('/readyz', { schema: { hide: true } }, async (_request, reply) => {
    try {
      await app.db.query('select 1');
      return { status: 'ok' };
    } catch (err) {
      app.log.error({ err }, 'readyz: fallo de conexión a la base de datos');
      reply.code(503);
      return { status: 'error', detail: 'database unreachable' };
    }
  });
}
