import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import client from 'prom-client';

/**
 * Métricas básicas de observabilidad (`GET /metrics`, formato Prometheus).
 * A propósito NO incluye ninguna etiqueta con datos de tenant (org_id,
 * user_id, nombres, emails, etc.): solo método, ruta normalizada (patrón de
 * la ruta de Fastify, no la URL con IDs) y código de estado. Ver
 * REQ-086/REQ-169: observabilidad honesta, sin filtrar datos de tenant.
 */
async function metricsPluginImpl(app: FastifyInstance): Promise<void> {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const httpRequestDuration = new client.Histogram({
    name: 'atiende_http_request_duration_seconds',
    help: 'Duración de peticiones HTTP en segundos, sin datos de tenant.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  const httpRequestsTotal = new client.Counter({
    name: 'atiende_http_requests_total',
    help: 'Total de peticiones HTTP, sin datos de tenant.',
    labelNames: ['method', 'route', 'status_code'],
    registers: [registry],
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions?.url ?? 'unmatched';
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.get('/metrics', { schema: { hide: true } }, async (_request, reply) => {
    reply.type(registry.contentType);
    return registry.metrics();
  });
}

export const metricsPlugin = fp(metricsPluginImpl, { name: 'metrics-plugin' });
