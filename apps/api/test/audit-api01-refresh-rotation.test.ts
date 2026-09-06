import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';

/**
 * Reproduce y verifica el cierre de API-01 (docs/auditoria-1/db-api.md,
 * ALTA): el mismo refreshToken se podía usar repetidamente (3 veces
 * seguidas en la auditoría), cada vez emitiendo tokens válidos nuevos, sin
 * rotación ni revocación real.
 */
describe('API-01: rotación y detección de reuso de refresh tokens', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('el mismo refreshToken usado una segunda vez es rechazado (401), no reemitido', async () => {
    const user = await registerAndLogin(app, 'api01-user@example.com');

    const first = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const { refreshToken: rotated } = first.json();
    expect(rotated).not.toBe(user.refreshToken);

    // Reuso del token YA rotado (el original, primera vez): debe fallar.
    const reuse1 = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(reuse1.statusCode).toBe(401);

    // Un tercer intento con el mismo token original tampoco debe funcionar.
    const reuse2 = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(reuse2.statusCode).toBe(401);

    // El token rotado (el nuevo, válido) SÍ debe seguir funcionando una vez.
    const validRefresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: rotated },
    });
    expect(validRefresh.statusCode).toBe(200);
  });

  it('POST /auth/logout revoca el refresh token: usarlo después falla', async () => {
    const user = await registerAndLogin(app, 'api01-logout-user@example.com');

    const logout = await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: user.refreshToken } });
    expect(logout.statusCode).toBe(204);

    const afterLogout = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: user.refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});
