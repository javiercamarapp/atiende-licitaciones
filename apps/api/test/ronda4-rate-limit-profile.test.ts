import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { loadConfig } from '../src/config.js';
import { getRateLimitSettings } from '../src/lib/rate-limit-settings.js';
import { createTestApp, TEST_JWT_SECRET, TEST_TOTP_ENCRYPTION_KEY } from './helpers.js';

/**
 * Ronda 4, item 4 (docs/logs/api-ronda4.log): `RATE_LIMIT_PROFILE=e2e` debe
 * elevar límites SOLO cuando esa variable está definida exactamente así --
 * nunca por defecto, ni siquiera con `NODE_ENV=test`/`development`. Cierra
 * el hallazgo real de `docs/logs/web-ronda3.log` (429 real de `/auth/login`
 * durante una suite E2E intensiva con varios workers/logins).
 */
describe('RATE_LIMIT_PROFILE (ronda 4)', () => {
  let app: FastifyInstance | undefined;
  let db: DbClient | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (db) await db.close();
    app = undefined;
    db = undefined;
  });

  it('loadConfig() sin RATE_LIMIT_PROFILE resuelve "default", incluso con NODE_ENV=test/development', () => {
    for (const nodeEnv of ['test', 'development', 'production', undefined]) {
      const cfg = loadConfig({
        JWT_SECRET: TEST_JWT_SECRET,
        TOTP_ENCRYPTION_KEY: TEST_TOTP_ENCRYPTION_KEY,
        ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
      } as NodeJS.ProcessEnv);
      expect(cfg.rateLimitProfile).toBe('default');
    }
  });

  it('loadConfig() con RATE_LIMIT_PROFILE=e2e (exacto) resuelve "e2e"', () => {
    const cfg = loadConfig({ JWT_SECRET: TEST_JWT_SECRET, TOTP_ENCRYPTION_KEY: TEST_TOTP_ENCRYPTION_KEY, RATE_LIMIT_PROFILE: 'e2e' } as NodeJS.ProcessEnv);
    expect(cfg.rateLimitProfile).toBe('e2e');
  });

  it('loadConfig() con un valor distinto de "e2e" (mayúsculas, typo, "E2E", "true") NUNCA activa el perfil elevado', () => {
    for (const value of ['E2E', 'E2e', 'true', '1', 'staging', ' e2e ', '']) {
      const cfg = loadConfig({ JWT_SECRET: TEST_JWT_SECRET, TOTP_ENCRYPTION_KEY: TEST_TOTP_ENCRYPTION_KEY, RATE_LIMIT_PROFILE: value } as NodeJS.ProcessEnv);
      expect(cfg.rateLimitProfile).toBe('default');
    }
  });

  it('getRateLimitSettings("default") es estrictamente más estricto que getRateLimitSettings("e2e") en las 3 categorías', () => {
    const def = getRateLimitSettings('default');
    const e2e = getRateLimitSettings('e2e');
    expect(e2e.global.max).toBeGreaterThan(def.global.max);
    expect(e2e.auth.max).toBeGreaterThan(def.auth.max);
    expect(e2e.sensitiveAction.max).toBeGreaterThan(def.sensitiveAction.max);
  });

  it('perfil default: POST /auth/login sigue devolviendo 429 en el 6º intento del minuto (comportamiento real sin cambios)', async () => {
    ({ app, db } = await createTestApp());
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nadie-rl-default@example.com', password: 'x' } })
      );
    }
    expect(results.slice(0, 5).every((r) => r.statusCode === 401)).toBe(true);
    expect(results[5].statusCode).toBe(429);
  });

  it('perfil e2e (activado EXPLÍCITAMENTE vía override de config, nunca por defecto): 20 intentos de login seguidos NO disparan 429', async () => {
    ({ app, db } = await createTestApp({ rateLimitProfile: 'e2e' }));
    const results = [];
    for (let i = 0; i < 20; i++) {
      results.push(
        await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nadie-rl-e2e@example.com', password: 'x' } })
      );
    }
    expect(results.every((r) => r.statusCode === 401)).toBe(true);
  });

  it('respuesta de 429 trae Retry-After y cabeceras X-RateLimit-* (documentación del comportamiento ya provisto por @fastify/rate-limit)', async () => {
    ({ app, db } = await createTestApp());
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'nadie-rl-headers@example.com', password: 'x' } });
    }
    expect(last!.statusCode).toBe(429);
    expect(last!.headers['retry-after']).toBeDefined();
    expect(last!.headers['x-ratelimit-limit']).toBeDefined();
    expect(last!.headers['x-ratelimit-remaining']).toBeDefined();
  });

  it('/agents/tool-calls/:id/approve aísla el presupuesto por organización (agotar el límite en org A no afecta a org B)', async () => {
    ({ app, db } = await createTestApp());
    const { registerAndLogin, createOrgFor } = await import('./helpers.js');
    const ownerA = await registerAndLogin(app, 'rl-org-a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'RL Org A', 'rl-org-a');
    const ownerB = await registerAndLogin(app, 'rl-org-b@example.com');
    const orgB = await createOrgFor(app, ownerB, 'RL Org B', 'rl-org-b');

    const max = getRateLimitSettings('default').sensitiveAction.max;

    // Agota el límite de org A contra tool_calls INEXISTENTES (404) -- el
    // límite de tasa corre en el hook `preHandler`, DESPUÉS de
    // `app.requireOrg` pero ANTES del handler, así que cuenta igual aunque
    // la tool_call no exista.
    let lastA;
    for (let i = 0; i <= max; i++) {
      lastA = await app.inject({
        method: 'POST',
        url: `/agents/tool-calls/00000000-0000-0000-0000-00000000000${i % 10}/approve`,
        headers: { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgA.id },
      });
    }
    expect(lastA!.statusCode).toBe(429);

    // org B, sin ninguna petición previa, no está afectada por el consumo de org A.
    const resB = await app.inject({
      method: 'POST',
      url: '/agents/tool-calls/00000000-0000-0000-0000-000000000000/approve',
      headers: { authorization: `Bearer ${ownerB.accessToken}`, 'x-org-id': orgB.id },
    });
    expect(resB.statusCode).not.toBe(429);
  });
});
