import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';

/**
 * Reproduce y verifica el cierre de API-04 (docs/auditoria-1/db-api.md,
 * BAJA): `requireOrg` no validaba el formato de `X-Org-Id` antes de usarlo
 * en la consulta, así que un valor que no era un UUID producía un 500 con
 * el mensaje crudo de Postgres ("invalid input syntax for type uuid: ...")
 * fuera de producción.
 */
describe('API-04: X-Org-Id con formato inválido responde 400, nunca 500', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('X-Org-Id que no es un UUID responde 400 (no 500) en cualquier ruta que requiera organización', async () => {
    const user = await registerAndLogin(app, 'api04-user@example.com');

    const res = await app.inject({
      method: 'GET',
      url: '/organizations',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.statusCode).toBe(200); // sanity: ruta sin X-Org-Id sigue funcionando

    const bad = await app.inject({
      method: 'GET',
      url: '/company/profile',
      headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': 'not-a-uuid' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.statusCode).not.toBe(500);
  });
});
