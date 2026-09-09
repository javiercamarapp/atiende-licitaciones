import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // D-11 (despliegue serverless en Vercel): el limitador GLOBAL ahora
  // persiste en Postgres (`rate_limit_buckets`, ver `lib/rate-limit-store.ts`)
  // en vez de un `LocalStore` en memoria -- sin `rateLimit: false` aquí,
  // TODA petición a `/healthz` pasaría por un `onRequest` que consulta la
  // base de datos, rompiendo la garantía ya probada ("nunca toca la base de
  // datos", ver test/rate-limit-and-health.test.ts) y, en `/readyz`, un
  // fallo del propio limitador (base de datos caída, exactamente lo que
  // ese endpoint simula) devolvía un 500 sin control ANTES de que el
  // `try/catch` de la ruta pudiera responder su propio 503 explícito. Estos
  // dos endpoints son sondas de infraestructura sin datos sensibles ni
  // costo real de cómputo -- excluirlas del limitador no abre ninguna
  // superficie de abuso nueva.
  app.get('/healthz', { schema: { hide: true }, config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  app.get('/readyz', { schema: { hide: true }, config: { rateLimit: false } }, async (_request, reply) => {
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
