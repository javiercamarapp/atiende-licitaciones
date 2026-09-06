import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';

/**
 * Reproduce y verifica el cierre de API-05 (docs/auditoria-1/db-api.md,
 * MEDIA): la API no enviaba ninguna cabecera de seguridad HTTP
 * (X-Content-Type-Options, X-Frame-Options, Strict-Transport-Security).
 */
describe('API-05: cabeceras de seguridad HTTP presentes en toda respuesta', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('GET /healthz responde con cabeceras de seguridad de @fastify/helmet', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeTruthy();
    expect(res.headers['x-dns-prefetch-control']).toBeTruthy();
  });
});
