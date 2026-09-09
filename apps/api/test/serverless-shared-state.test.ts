import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPgliteClient } from '@atiende/db';
import type { DbClient } from '@atiende/db';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import {
  TEST_JWT_SECRET,
  TEST_PLATFORM_API_KEY,
  TEST_TOTP_ENCRYPTION_KEY,
  TEST_MAIL_LINK_SECRET,
} from './helpers.js';
import { startFakeOidcProvider, parseAuthorizationUrl, type FakeOidcProvider } from './helpers/fake-oidc.js';

/**
 * D-11 (docs/DECISIONES.md, despliegue serverless en Vercel): en producción
 * dos requests consecutivas del MISMO cliente pueden aterrizar en dos
 * invocaciones/instancias de Node totalmente distintas de `apps/api` (cada
 * una con su propio `buildApp()` -- ver `api/index.ts`) que comparten
 * ÚNICAMENTE la base de datos, nunca memoria de proceso. Esta suite
 * reproduce exactamente esa condición con dos `buildApp()` reales sobre la
 * MISMA conexión PGlite (en vez de una sola app reutilizada, como hace el
 * resto de `test/*.test.ts`): si algo quedara en memoria de proceso en vez
 * de Postgres, la segunda instancia lo vería "vacío" y estas pruebas
 * fallarían.
 */
async function buildTestApp(db: DbClient, overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  const config: AppConfig = {
    ...loadConfig({
      JWT_SECRET: TEST_JWT_SECRET,
      NODE_ENV: 'test',
      STORAGE_DIR: mkdtempSync(join(tmpdir(), 'atiende-api-test-storage-')),
      PLATFORM_API_KEY: TEST_PLATFORM_API_KEY,
      TOTP_ENCRYPTION_KEY: TEST_TOTP_ENCRYPTION_KEY,
      MAIL_LINK_SECRET: TEST_MAIL_LINK_SECRET,
    }),
    port: 0,
    databaseUrl: undefined,
    // Las migraciones ya las aplica la primera instancia: la segunda NO
    // debe reintentarlas (mismo `db`, `applyMigrations` ya es idempotente,
    // pero evita el trabajo doble en cada test).
    autoMigrate: false,
    ...overrides,
  };
  const app = await buildApp({ db, config, logger: false });
  await app.ready();
  return app;
}

describe('D-11: dos instancias serverless de apps/api sobre la MISMA base de datos', () => {
  describe('límite de tasa persistido (rate_limit_buckets)', () => {
    let db: DbClient;
    let appA: FastifyInstance;
    let appB: FastifyInstance;

    beforeAll(async () => {
      db = await createPgliteClient();
      appA = await buildTestApp(db, { autoMigrate: true });
      appB = await buildTestApp(db);
    });

    afterAll(async () => {
      await appA.close();
      await appB.close();
      await db.close();
    });

    it('el contador de /auth/login (tier "auth", 5/min) se comparte entre dos buildApp() distintos', async () => {
      const attempt = (app: FastifyInstance) =>
        app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'compartido@example.com', password: 'x' },
        });

      // 3 peticiones contra la instancia A, 2 contra B: si el límite fuera
      // por PROCESO (el bug real que este store corrige), ninguna de las 5
      // dispararía un 429 (cada instancia vería solo su propia mitad, muy
      // por debajo de 5). Con el store persistido, la 6ª petición (contra
      // CUALQUIERA de las dos instancias) debe ver el total combinado.
      const results = [
        await attempt(appA),
        await attempt(appA),
        await attempt(appA),
        await attempt(appB),
        await attempt(appB),
      ];
      expect(results.every((r) => r.statusCode === 401)).toBe(true);

      const sixthOnB = await attempt(appB);
      expect(sixthOnB.statusCode).toBe(429);

      const seventhOnA = await attempt(appA);
      expect(seventhOnA.statusCode).toBe(429);
    });
  });

  describe('estado OIDC (oauth_states, REQ-172)', () => {
    const GOOGLE_CLIENT_ID = 'test-google-client-id-shared';
    const GOOGLE_CLIENT_SECRET = 'test-google-client-secret-shared';
    const GOOGLE_REDIRECT_URI = 'https://app.example.test/auth/google/callback';

    let db: DbClient;
    let appA: FastifyInstance;
    let appB: FastifyInstance;
    let provider: FakeOidcProvider;

    beforeAll(async () => {
      provider = await startFakeOidcProvider();
      process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
      process.env.GOOGLE_CLIENT_SECRET = GOOGLE_CLIENT_SECRET;
      process.env.GOOGLE_REDIRECT_URI = GOOGLE_REDIRECT_URI;
      process.env.OIDC_ISSUER_URL = provider.issuerUrl;

      db = await createPgliteClient();
      appA = await buildTestApp(db, { autoMigrate: true });
      appB = await buildTestApp(db);
    });

    afterAll(async () => {
      await appA.close();
      await appB.close();
      await db.close();
      await provider.close();
      delete process.env.GOOGLE_CLIENT_ID;
      delete process.env.GOOGLE_CLIENT_SECRET;
      delete process.env.GOOGLE_REDIRECT_URI;
      delete process.env.OIDC_ISSUER_URL;
    });

    it('GET /auth/google/start en la instancia A y GET /auth/google/callback en la instancia B completan el mismo login (state/nonce/PKCE viven en Postgres, no en memoria de proceso)', async () => {
      const start = await appA.inject({ method: 'GET', url: '/auth/google/start' });
      expect(start.statusCode).toBe(200);
      const { state, nonce, codeChallenge } = parseAuthorizationUrl(start.json().authorizationUrl);

      const code = provider.issueAuthorizationCode({
        sub: 'google-sub-shared-state',
        email: 'shared-state@example.com',
        emailVerified: true,
        aud: GOOGLE_CLIENT_ID,
        nonce,
        codeChallenge,
      });

      // La instancia que resuelve el callback NUNCA vio `/auth/google/start`:
      // si `oauth_states`/PKCE/nonce vivieran en un `Map` en memoria de
      // `appA` (o en cualquier caché de proceso), `appB` no tendría forma de
      // encontrar el `state` y esto fallaría con "state inválido o expirado".
      const callback = await appB.inject({
        method: 'GET',
        url: '/auth/google/callback',
        query: { code, state },
      });
      expect(callback.statusCode).toBe(200);
      const body = callback.json();
      expect(typeof body.accessToken).toBe('string');

      // El `state` ya fue consumido (de un solo uso): repetirlo, incluso
      // contra la instancia A que sí lo emitió, debe rechazarse -- confirma
      // que el consumo también es una escritura real y visible en Postgres,
      // no un efecto secundario local de `appB`.
      const replay = await appA.inject({
        method: 'GET',
        url: '/auth/google/callback',
        query: { code, state },
      });
      expect(replay.statusCode).toBe(400);
    });
  });
});
