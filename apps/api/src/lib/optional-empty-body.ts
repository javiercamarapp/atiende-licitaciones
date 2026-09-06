import type { FastifyInstance } from 'fastify';

/**
 * Ronda 4 (item 5, docs/logs/api-ronda4.log): un `POST` sin cuerpo pero con
 * `Content-Type: application/json` (p. ej. un wrapper HTTP que siempre fija
 * ese header por costumbre) hace que el parser JSON por defecto de Fastify
 * lance `FST_ERR_CTP_EMPTY_JSON_BODY` -> 400 -- comportamiento correcto en
 * general (un cuerpo vacío con `Content-Type: application/json` es, en el
 * caso general, una petición mal formada) pero indeseable en rutas de
 * ACCIÓN que nunca esperan cuerpo (`approve`/`deny`/`retry`/`resolve`):
 * `apps/web` (docs/logs/web-ronda3.log) documentó el bug simétrico del lado
 * del cliente (declaraba ese header incluso sin cuerpo) y lo corrigió ahí;
 * esta función cierra el mismo caso desde el lado del servidor para las
 * rutas que genuinamente no necesitan cuerpo, sin relajar nada para el
 * resto de la API.
 *
 * Registra, en un contexto ENCAPSULADO (`app.register`, con su propio
 * scope de Fastify), un parser de `application/json` que tolera un cuerpo
 * vacío (lo resuelve a `undefined` en vez de lanzar). Como Fastify
 * encapsula los content-type parsers por contexto de plugin, este parser
 * SOLO afecta a las rutas registradas dentro del callback `register` -- el
 * resto de la API (incluidas rutas del mismo archivo que sí exigen cuerpo,
 * como `POST /admin/incidents`) conserva el comportamiento estricto de
 * Fastify sin cambios.
 */
export async function withOptionalEmptyJsonBody(
  app: FastifyInstance,
  register: (scoped: FastifyInstance) => void | Promise<void>
): Promise<void> {
  await app.register(async (scoped) => {
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : body;
      if (raw === '' || raw === undefined || raw === null) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    });
    await register(scoped);
  });
}
