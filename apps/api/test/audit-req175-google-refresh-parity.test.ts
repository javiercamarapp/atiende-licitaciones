import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, TEST_JWT_SECRET } from './helpers.js';
import { startFakeOidcProvider, parseAuthorizationUrl, type FakeOidcProvider } from './helpers/fake-oidc.js';
import { verifyRefreshToken } from '../src/lib/jwt.js';

/**
 * REQ-175 (docs/ACEPTACION.md): brecha honesta detectada por el auditor --
 * `issueTokenPair` (modules/auth/routes.ts) es literalmente el mismo
 * emisor para el login por email+contraseña y para el login con Google
 * (`modules/auth/google/routes.ts`), pero ninguna prueba lo verificaba por
 * EJECUCIÓN: no existía una prueba de CONTRATO que comparara esquema y
 * expiración de un refresh token de Google contra uno de email+contraseña,
 * ni ninguna prueba que ROTARA un refresh token emitido por el flujo de
 * Google (`test/audit-api01-refresh-rotation.test.ts` nunca menciona
 * Google). Lo único aseverado antes de esta prueba era
 * `typeof refreshToken === 'string'` y que el `accessToken` sirviera en
 * `GET /organizations` (`test/google-oidc-login.test.ts`, caso S1).
 *
 * Esta suite cierra esa brecha en dos partes:
 *  1. Contrato de esquema/expiración: el refresh token que emite el login
 *     con Google (OIDC falso, `test/helpers/fake-oidc.ts`) tiene EXACTAMENTE
 *     la misma forma (`typ`/`sub`/`jti` en el JWT) y la misma ventana de
 *     expiración (TTL) que el que emite el login por email+contraseña --
 *     tanto en el propio JWT (`exp - iat`) como en la fila persistida de
 *     `refresh_tokens` (`expires_at - created_at`).
 *  2. Rotación real: el refresh token de Google se puede usar UNA VEZ en
 *     `POST /auth/refresh` (200, tokens nuevos) y reusar el original
 *     después es rechazado (401) -- mismo mecanismo de detección de reuso
 *     (`app.rotate_refresh_token`, API-01/0043) que ya cubre
 *     `audit-api01-refresh-rotation.test.ts` para email+contraseña,
 *     replicado aquí para el flujo de Google.
 */
describe('REQ-175: paridad de esquema/TTL y rotación del refresh token entre Google y email+contraseña', () => {
  const GOOGLE_CLIENT_ID = 'test-google-client-id-req175';
  const GOOGLE_CLIENT_SECRET = 'test-google-client-secret-req175-not-real';
  const GOOGLE_REDIRECT_URI = 'https://app.example.test/auth/google/callback';

  let provider: FakeOidcProvider;
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    provider = await startFakeOidcProvider();
    process.env.GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_REDIRECT_URI = GOOGLE_REDIRECT_URI;
    process.env.OIDC_ISSUER_URL = provider.issuerUrl;
    ({ app, db } = await createTestApp({ rateLimitProfile: 'e2e' }));
  });

  afterAll(async () => {
    await app.close();
    await db.close();
    await provider.close();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
    delete process.env.OIDC_ISSUER_URL;
  });

  async function loginWithGoogle(
    email: string,
    sub: string,
    headers: Record<string, string> = {}
  ): Promise<{ userId: string; accessToken: string; refreshToken: string }> {
    const start = await app.inject({ method: 'GET', url: '/auth/google/start' });
    expect(start.statusCode).toBe(200);
    const { state, nonce, codeChallenge } = parseAuthorizationUrl(start.json().authorizationUrl);

    const code = provider.issueAuthorizationCode({ sub, email, emailVerified: true, aud: GOOGLE_CLIENT_ID, nonce, codeChallenge });
    const callback = await app.inject({ method: 'GET', url: '/auth/google/callback', query: { code, state }, headers });
    expect(callback.statusCode).toBe(200);
    const body = callback.json();
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');

    const userRow = await db.query<{ id: string }>('select id from users where lower(email) = $1', [email.toLowerCase()]);
    expect(userRow.rows.length).toBe(1);

    return { userId: userRow.rows[0].id, accessToken: body.accessToken, refreshToken: body.refreshToken };
  }

  /** `refresh_tokens.expires_at - refresh_tokens.created_at`, en segundos, para la fila más reciente del usuario. */
  async function refreshTokenTtlSecondsFor(userId: string): Promise<number> {
    const { rows } = await db.query<{ ttl_seconds: number }>(
      "select extract(epoch from (expires_at - created_at))::float8 as ttl_seconds from refresh_tokens where user_id = $1 order by created_at desc limit 1",
      [userId]
    );
    expect(rows.length).toBe(1);
    return rows[0].ttl_seconds;
  }

  it('el refresh token de Google tiene el MISMO esquema (typ/sub/jti) y el MISMO TTL que el de email+contraseña (contrato REQ-175)', async () => {
    const passwordUser = await registerAndLogin(app, 'req175-password@example.com');
    const google = await loginWithGoogle('req175-google@example.com', 'google-sub-req175-schema');

    // Esquema: `issueTokenPair` firma AMBOS con `signRefreshToken` --
    // `verifyRefreshToken` (mismo secreto, mismo verificador que usa el
    // propio servidor en `POST /auth/refresh`) debe aceptar los dos y
    // exponer exactamente los mismos claims de tipo.
    const passwordPayload = await verifyRefreshToken(TEST_JWT_SECRET, passwordUser.refreshToken);
    const googlePayload = await verifyRefreshToken(TEST_JWT_SECRET, google.refreshToken);
    expect(googlePayload.typ).toBe('refresh');
    expect(googlePayload.typ).toBe(passwordPayload.typ);
    expect(typeof googlePayload.jti).toBe('string');
    expect(googlePayload.sub).toBe(google.userId);

    // Expiración DEL JWT: `exp - iat` (en segundos) idéntico entre los dos
    // flujos -- ambos vienen de la misma llamada `setExpirationTime('30d')`
    // en `signRefreshToken` (lib/jwt.ts), nunca una constante duplicada.
    expect(passwordPayload.exp).toBeDefined();
    expect(passwordPayload.iat).toBeDefined();
    expect(googlePayload.exp).toBeDefined();
    expect(googlePayload.iat).toBeDefined();
    const passwordTtl = passwordPayload.exp! - passwordPayload.iat!;
    const googleTtl = googlePayload.exp! - googlePayload.iat!;
    expect(googleTtl).toBe(passwordTtl);
    expect(googleTtl).toBe(30 * 24 * 60 * 60); // 30 días, REFRESH_TTL_DAYS en modules/auth/routes.ts

    // Expiración PERSISTIDA: `refresh_tokens.expires_at - created_at`
    // (columna que gobierna `app.rotate_refresh_token`/`find_refresh_token`,
    // independiente del JWT) también idéntica entre los dos flujos.
    const passwordRowTtl = await refreshTokenTtlSecondsFor(passwordUser.id);
    const googleRowTtl = await refreshTokenTtlSecondsFor(google.userId);
    expect(googleRowTtl).toBeCloseTo(passwordRowTtl, 0);
    expect(googleRowTtl).toBeCloseTo(30 * 24 * 60 * 60, 0);
  });

  it('un refresh token emitido por Google rota igual que uno de email+contraseña: reusar el original tras rotar es rechazado (401) (REQ-175)', async () => {
    const google = await loginWithGoogle('req175-google-rotation@example.com', 'google-sub-req175-rotation');

    const first = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: google.refreshToken } });
    expect(first.statusCode).toBe(200);
    const rotated = first.json();
    expect(typeof rotated.accessToken).toBe('string');
    expect(typeof rotated.refreshToken).toBe('string');
    expect(rotated.refreshToken).not.toBe(google.refreshToken);

    // Reuso del token YA rotado (el original de Google): igual que
    // `audit-api01-refresh-rotation.test.ts` con email+contraseña, debe
    // rechazarse -- nunca reemitirse.
    const reuse = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: google.refreshToken } });
    expect(reuse.statusCode).toBe(401);

    // El reuso detectado revoca preventivamente TODA la familia de
    // sesiones activas (API-01/API-09, `app.rotate_refresh_token`, 0043) --
    // MISMO comportamiento exacto que `audit-api01-refresh-rotation.test.ts`
    // ejerce para email+contraseña ("rotatedAfterReuseDetected"): el token
    // recién rotado, aunque nunca se reusó él mismo, también queda
    // revocado. No es un rechazo "más estricto" para Google -- es la misma
    // función SQL, el mismo mecanismo, para los dos flujos.
    const afterRotation = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: rotated.refreshToken } });
    expect(afterRotation.statusCode).toBe(401);

    // El reuso detectado queda en audit_log con la MISMA acción que el
    // flujo de email+contraseña (`auth.refresh_reuse_detected`, ver
    // `test/audit-api01-refresh-rotation.test.ts` para el equivalente sin
    // Google) -- confirma que ambos flujos comparten el mismo mecanismo de
    // auditoría, no solo el mismo código de estado HTTP.
    const reuseAudit = await db.query(
      "select 1 from audit_log where entity = 'auth' and action = 'auth.refresh_reuse_detected' and actor_id = $1",
      [google.userId]
    );
    expect(reuseAudit.rows.length).toBeGreaterThan(0);
  });

  /**
   * REQ-177 (docs/ACEPTACION.md): mismo cierre que
   * `test/security-api13-auth-audit-log.test.ts` (email+contraseña), pero
   * ejercido sobre el flujo de Google en concreto -- el hallazgo original
   * señalaba "paridad exacta" con email+contraseña (ninguno de los dos
   * llenaba `correlation_id`); esta prueba confirma que, tras el cierre,
   * la paridad se mantiene EN SENTIDO POSITIVO: el `X-Correlation-Id`
   * enviado en el callback de Google llega igual de intacto a
   * `audit_log.correlation_id` que en el login por contraseña.
   */
  it('el X-Correlation-Id del callback de Google llega intacto a audit_log.correlation_id en auth.google_login (REQ-177, paridad con email+contraseña)', async () => {
    const correlationId = '22222222-2222-4222-8222-222222222222';
    const google = await loginWithGoogle('req177-google-correlation@example.com', 'google-sub-req177-correlation', {
      'x-correlation-id': correlationId,
    });

    const rows = await db.query<{ correlation_id: string | null }>(
      "select correlation_id from audit_log where entity = 'auth' and action = 'auth.google_login' and actor_id = $1",
      [google.userId]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].correlation_id).toBe(correlationId);
  });
});
