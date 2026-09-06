import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';

/**
 * Ronda 4, item 1 (docs/logs/api-ronda4.log): bug real encontrado por
 * apps/web (docs/logs/web-ronda3.log) -- `@fastify/cors` sin `methods`
 * explícitos respondía el preflight con
 * `access-control-allow-methods: GET,HEAD,POST`, sin PUT/PATCH/DELETE,
 * bloqueando toda escritura cross-origin real en el propio navegador.
 */
describe('CORS (ronda 4) — preflight real por método', () => {
  let app: FastifyInstance;
  let db: DbClient;

  const ORIGIN = 'https://back-office.atiende.test';

  beforeAll(async () => {
    ({ app, db } = await createTestApp({ corsOrigins: [ORIGIN] }));
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  const METHODS_TO_CHECK = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

  for (const method of METHODS_TO_CHECK) {
    it(`preflight OPTIONS para ${method} responde access-control-allow-methods incluyendo ${method}`, async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/company/profile',
        headers: {
          origin: ORIGIN,
          'access-control-request-method': method,
          'access-control-request-headers': 'authorization,x-org-id',
        },
      });
      expect(res.statusCode).toBeLessThan(300);
      const allowMethods = String(res.headers['access-control-allow-methods'] ?? '');
      expect(allowMethods.split(',').map((m) => m.trim())).toContain(method);
    });
  }

  it('preflight refleja los headers custom reales que usa la API (Authorization, X-Org-Id, Idempotency-Key, Content-Type)', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/organizations/invitations',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,x-org-id,idempotency-key,content-type',
      },
    });
    expect(res.statusCode).toBeLessThan(300);
    const allowHeaders = String(res.headers['access-control-allow-headers'] ?? '').toLowerCase();
    for (const header of ['authorization', 'x-org-id', 'idempotency-key', 'content-type']) {
      expect(allowHeaders).toContain(header);
    }
  });

  it('expone las cabeceras de límite de tasa a JS cross-origin (Access-Control-Expose-Headers)', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/tenders',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'GET',
      },
    });
    // Nota: `Access-Control-Expose-Headers` va en la respuesta REAL (no en
    // el preflight), así que se verifica con una petición GET normal.
    const real = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: ORIGIN } });
    const exposed = String(real.headers['access-control-expose-headers'] ?? '').toLowerCase();
    expect(exposed).toContain('retry-after');
    expect(exposed).toContain('x-ratelimit-limit');
    void res;
  });

  it('un origen NO configurado no recibe access-control-allow-origin (falla cerrado)', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/company/profile',
      headers: {
        origin: 'https://origen-no-permitido.test',
        'access-control-request-method': 'PUT',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
