import { randomUUID } from 'node:crypto';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * REQ-171 (extiende REQ-084 al ciclo completo del expediente): identificador
 * de correlación único por request, distinto de `request.id`
 * (Fastify `genReqId`, ver `app.ts` -- ese es un id técnico de request/log,
 * no el hilo de negocio "convocatoria -> matriz -> propuesta -> paquete ->
 * archivo" que puede abarcar VARIAS requests de un mismo flujo).
 *
 * Reglas:
 *  - si el llamador manda `X-Correlation-Id` con un UUID válido, se
 *    HEREDA (permite a un cliente/orquestador correlacionar su propio flujo
 *    multi-request, p. ej. "ingestar convocatoria" -> "recalcular matriz"
 *    -> "generar propuesta" -> "aprobar" -> "ensamblar paquete", todas con
 *    el mismo id).
 *  - si no manda nada, o manda un valor que NO es un UUID válido (para no
 *    envenenar la auditoría con basura no verificable), se GENERA uno
 *    nuevo -- nunca se rechaza la request por esto, es un dato de
 *    trazabilidad, no de autorización.
 *  - siempre se refleja en la respuesta (`X-Correlation-Id`) para que el
 *    cliente sepa qué id quedó realmente asociado, igual que ya hace
 *    `X-Request-Id`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveCorrelationId(headerValue: string | string[] | undefined): string {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (raw && UUID_RE.test(raw)) return raw;
  return randomUUID();
}

async function correlationIdPluginImpl(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    request.correlationId = resolveCorrelationId(request.headers['x-correlation-id']);
    reply.header('x-correlation-id', request.correlationId);
  });
}

export const correlationIdPlugin = fp(correlationIdPluginImpl, { name: 'correlation-id-plugin' });
