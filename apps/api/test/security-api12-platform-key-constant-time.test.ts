import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * API-12 (docs/auditoria-1/db-api-reverificacion.md, BAJA) —
 * `requirePlatformApiKey` comparaba el secreto de plataforma con `!==`
 * (canal de timing teórico); ahora usa `timingSafeEqual` con longitudes
 * igualadas primero. Esta prueba es funcional (correctitud del guard
 * constante en tiempo, no una medición de timing real -- eso ya se hace
 * para /auth/login en security-api03-login-timing.test.ts con un umbral
 * estadístico, y un ataque de timing contra este endpoint interno
 * requeriría acceso de red al servicio, fuera de alcance de un test
 * unitario): la clave correcta autentica, cualquier variación (más corta,
 * más larga, distinta en el último byte, distinta en el primer byte) se
 * rechaza igual, para descartar una regresión funcional al introducir
 * `timingSafeEqual` (que exige longitudes iguales o lanza).
 */
describe('API-12 — comparación de X-Platform-Api-Key sigue siendo correcta con timingSafeEqual', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  const payload = { records: [{ source: 'compras-mx', externalId: 'api12-x', title: 'x', sourceVersion: 'v1' }] };

  it('la clave correcta autentica (200)', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/tenders/ingest', headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY }, payload });
    expect(res.statusCode).toBe(200);
  });

  it('una clave más CORTA que la esperada se rechaza (401), no lanza por longitud desigual', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/tenders/ingest', headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY.slice(0, -1) }, payload });
    expect(res.statusCode).toBe(401);
  });

  it('una clave más LARGA que la esperada se rechaza (401), no lanza por longitud desigual', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/tenders/ingest', headers: { 'x-platform-api-key': `${TEST_PLATFORM_API_KEY}x` }, payload });
    expect(res.statusCode).toBe(401);
  });

  it('una clave de la misma longitud pero distinta en el ÚLTIMO byte se rechaza (401)', async () => {
    const tampered = `${TEST_PLATFORM_API_KEY.slice(0, -1)}${TEST_PLATFORM_API_KEY.at(-1) === 'x' ? 'y' : 'x'}`;
    expect(tampered.length).toBe(TEST_PLATFORM_API_KEY.length);
    const res = await app.inject({ method: 'POST', url: '/internal/tenders/ingest', headers: { 'x-platform-api-key': tampered }, payload });
    expect(res.statusCode).toBe(401);
  });

  it('una clave de la misma longitud pero distinta en el PRIMER byte se rechaza (401)', async () => {
    const tampered = `${TEST_PLATFORM_API_KEY[0] === 'z' ? 'y' : 'z'}${TEST_PLATFORM_API_KEY.slice(1)}`;
    expect(tampered.length).toBe(TEST_PLATFORM_API_KEY.length);
    const res = await app.inject({ method: 'POST', url: '/internal/tenders/ingest', headers: { 'x-platform-api-key': tampered }, payload });
    expect(res.statusCode).toBe(401);
  });

  it('sin encabezado se rechaza (401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/tenders/ingest', payload });
    expect(res.statusCode).toBe(401);
  });
});
