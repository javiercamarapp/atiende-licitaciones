import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';

/**
 * WI-01 (docs/auditoria-2/web-integrado.md): `contentSecurityPolicy: false`
 * dejaba esta API sin ningún CSP real. Se activa una política restrictiva
 * (default-src/script-src 'self'; connect-src 'self' + orígenes de
 * CORS_ORIGINS; frame-ancestors 'none'; object-src 'none') + Permissions-Policy
 * explícito, verificados en TODAS las rutas (incluida /docs/json).
 */
describe('WI-01: Content-Security-Policy y Permissions-Policy reales', () => {
  let app: FastifyInstance;
  let db: DbClient;

  const FRONTEND_ORIGIN = 'https://back-office.atiende.test';

  beforeAll(async () => {
    ({ app, db } = await createTestApp({ corsOrigins: [FRONTEND_ORIGIN] }));
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('GET /healthz trae un CSP real con las directivas esperadas', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).not.toBe('');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('connect-src incluye \'self\' Y el origen del frontend configurado en CORS_ORIGINS', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toMatch(/connect-src[^;]*'self'/);
    expect(csp).toContain(FRONTEND_ORIGIN);
  });

  it('Permissions-Policy explícito presente', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['permissions-policy']).toBeTruthy();
    expect(String(res.headers['permissions-policy'])).toContain('camera=()');
  });

  it('Referrer-Policy y X-Content-Type-Options ya presentes (regresión, ver API-05) siguen presentes', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['referrer-policy']).toBeTruthy();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('las cabeceras también están presentes en /docs/json (sesión válida)', async () => {
    const user = await registerAndLogin(app, 'wi01-user@example.com');
    const res = await app.inject({ method: 'GET', url: '/docs/json', headers: { authorization: `Bearer ${user.accessToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['permissions-policy']).toBeTruthy();
  });

  it('las cabeceras también están presentes en una respuesta de ERROR (404)', async () => {
    const res = await app.inject({ method: 'GET', url: '/ruta-que-no-existe' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['permissions-policy']).toBeTruthy();
  });

  it('las cabeceras también están presentes en una respuesta de error de aplicación (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-security-policy']).toBeTruthy();
    expect(res.headers['permissions-policy']).toBeTruthy();
  });
});
