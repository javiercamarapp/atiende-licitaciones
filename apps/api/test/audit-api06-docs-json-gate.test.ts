import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';

/**
 * Reproduce y verifica el cierre de API-06 (docs/auditoria-1/db-api.md,
 * BAJA): GET /docs/json (esquema OpenAPI completo) era accesible sin
 * autenticación.
 */
describe('API-06: /docs/json requiere autenticación', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('sin token responde 401, no el esquema OpenAPI', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(401);
  });

  it('con un token de acceso válido sí devuelve el esquema OpenAPI', async () => {
    const user = await registerAndLogin(app, 'api06-user@example.com');
    const res = await app.inject({
      method: 'GET',
      url: '/docs/json',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('openapi');
  });
});
