import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';

/**
 * Reproduce y verifica el cierre de API-01 (docs/auditoria-1/db-api.md,
 * ALTA): el mismo refreshToken se podía usar repetidamente (3 veces
 * seguidas en la auditoría), cada vez emitiendo tokens válidos nuevos, sin
 * rotación ni revocación real.
 *
 * Ronda de reverificación (docs/auditoria-1/db-api-reverificacion.md,
 * API-01 PARCIAL / API-09): la rotación anterior hacía SELECT+UPDATE en
 * transacciones separadas (ventana TOCTOU real contra el pool de Postgres
 * de producción, no reproducible bajo PGlite por tener una única conexión
 * física). Fijado con `app.rotate_refresh_token`
 * (0043_fix_api01_atomic_refresh_rotation.sql): check-y-mutación en UNA
 * sola sentencia `UPDATE ... WHERE revoked_at IS NULL RETURNING`, con
 * detección de reuso que revoca TODA la familia de sesiones activas del
 * usuario (no solo el token reusado) -- comportamiento estándar de
 * rotación de refresh tokens con detección de robo: tras un reuso, se
 * fuerza a volver a iniciar sesión en vez de confiar en que el token
 * "más reciente" siga en manos del usuario legítimo.
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

    // Detección de reuso -> revocación de FAMILIA completa (API-01/API-09):
    // el reuso del token original ya revocó preventivamente TODAS las
    // sesiones activas del usuario, incluida la del token recién rotado
    // ("rotated") -- no es un bug, es la respuesta correcta ante una señal
    // de robo: no se puede confiar en que el token "más reciente" siga en
    // manos del usuario legítimo, así que se fuerza volver a autenticarse.
    const rotatedAfterReuseDetected = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: rotated },
    });
    expect(rotatedAfterReuseDetected.statusCode).toBe(401);
  });

  it('detección de reuso revoca la familia de sesiones, pero NO afecta a otro usuario', async () => {
    const victim = await registerAndLogin(app, 'api01-family-victim@example.com');
    const bystander = await registerAndLogin(app, 'api01-family-bystander@example.com');

    const rotated = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: victim.refreshToken },
    });
    expect(rotated.statusCode).toBe(200);

    // Reuso del token original de `victim` -> revoca su propia familia.
    const reuse = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: victim.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);

    // El refresh token de `bystander` (otro usuario, sin relación) sigue
    // funcionando con normalidad: la revocación de familia es por user_id,
    // nunca global.
    const bystanderRefresh = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: bystander.refreshToken },
    });
    expect(bystanderRefresh.statusCode).toBe(200);
  });

  it('dos peticiones de /auth/refresh simultáneas con el MISMO token: como mucho una tiene éxito', async () => {
    // Bajo PGlite (conexión física única, ver
    // docs/auditoria-1/db-api-reverificacion.md API-01) esto no reproduce
    // una carrera real de red -- pero SÍ ejercita que `app.rotate_refresh_token`
    // es seguro invocarlo dos veces "a la vez" (Promise.all) sin duplicar
    // tokens válidos ni lanzar un error no controlado: exactamente una
    // resolución debe ser 200 y la otra 401, nunca dos 200 ni un throw sin
    // capturar.
    const user = await registerAndLogin(app, 'api01-race-user@example.com');

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refreshToken } }),
      app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refreshToken } }),
    ]);

    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 401]);
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
