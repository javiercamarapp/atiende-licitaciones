import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';
import { startFakeOidcProvider, parseAuthorizationUrl, type FakeOidcProvider } from './helpers/fake-oidc.js';

/**
 * AM-01 (docs/auditoria-2/api-mail.md, ALTA -- roza CRÍTICA): reproduce el
 * escenario EXACTO de toma de cuenta que documentó el auditor:
 *
 *  1. Un ATACANTE, conociendo el correo de la víctima, ejecuta
 *     `POST /auth/register` con ese email y una contraseña de su elección.
 *     La cuenta queda `email_verified_at = NULL` (nunca verificada
 *     nativamente) -- el login con esa contraseña está bloqueado por la
 *     compuerta de verificación (correcto, sin cambios).
 *  2. La VÍCTIMA real, dueña del correo, usa "Continuar con Google"
 *     (REQ-172/173) -- Google prueba que controla ese correo. El sistema
 *     encuentra la cuenta "squatteada" por email y la vincula
 *     automáticamente.
 *  3. Antes del fix, la contraseña del atacante (nunca invalidada) seguía
 *     siendo válida en cuanto `email_verified_at` dejara de ser NULL por
 *     cualquier vía (el correo de verificación original, o un reenvío
 *     anónimo) -- toma de cuenta completa.
 *
 * Este test verifica que, INMEDIATAMENTE al vincular (sin esperar a
 * ninguna verificación nativa posterior), la reparación de AM-01 ya cerró
 * el vector: la contraseña del atacante queda inservible desde el mismo
 * acto de vinculación.
 */
describe('AM-01: vincular Google a una cuenta email+contraseña squatteada no verificada', () => {
  const GOOGLE_CLIENT_ID = 'am01-test-google-client-id';
  const GOOGLE_CLIENT_SECRET = 'am01-test-google-client-secret-not-real';
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
    const built = await createTestApp({ rateLimitProfile: 'e2e' });
    app = built.app;
    db = built.db;
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

  async function startFlow(): Promise<{ state: string; nonce: string; codeChallenge: string }> {
    const res = await app.inject({ method: 'GET', url: '/auth/google/start' });
    expect(res.statusCode).toBe(200);
    return parseAuthorizationUrl(res.json().authorizationUrl);
  }

  it(
    'ADVERSARIAL: la contraseña del atacante que squatteó el correo deja de servir en cuanto la víctima vincula Google',
    async () => {
      const victimEmail = 'am01-victima@example.com';
      const attackerPassword = 'password-del-atacante-123';

      // 1) El atacante se adelanta y registra el correo de la víctima con
      // SU contraseña -- la cuenta queda sin verificar.
      const attackerRegister = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: victimEmail, password: attackerPassword },
      });
      expect(attackerRegister.statusCode).toBe(201);
      await app.waitForPendingMail();

      const beforeLink = await db.query<{ id: string; password_hash: string | null; email_verified_at: string | null }>(
        'select id, password_hash, email_verified_at from users where lower(email) = $1',
        [victimEmail]
      );
      expect(beforeLink.rows.length).toBe(1);
      expect(beforeLink.rows[0].password_hash).not.toBeNull();
      expect(beforeLink.rows[0].email_verified_at).toBeNull();
      const userId = beforeLink.rows[0].id;

      // Confirma que, YA HOY, el login del atacante está bloqueado por la
      // compuerta de verificación (esto NUNCA fue el problema -- ver
      // docstring del módulo).
      const attackerLoginBeforeLink = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: victimEmail, password: attackerPassword },
      });
      expect(attackerLoginBeforeLink.statusCode).toBe(403);

      // 2) La víctima real entra con Google, probando que controla el
      // correo -- el sistema vincula automáticamente (REQ-173).
      const { state, nonce, codeChallenge } = await startFlow();
      const code = provider.issueAuthorizationCode({
        sub: 'am01-google-sub-victima',
        email: victimEmail,
        emailVerified: true,
        aud: GOOGLE_CLIENT_ID,
        nonce,
        codeChallenge,
      });
      const callbackRes = await app.inject({ method: 'GET', url: '/auth/google/callback', query: { code, state } });
      expect(callbackRes.statusCode).toBe(200);

      // 3) AM-01: la vinculación por sí sola -- SIN esperar ninguna
      // verificación nativa posterior -- ya debe haber invalidado la
      // contraseña del atacante y marcado el correo verificado por Google.
      const afterLink = await db.query<{ password_hash: string | null; email_verified_at: string | null }>(
        'select password_hash, email_verified_at from users where id = $1',
        [userId]
      );
      expect(afterLink.rows[0].password_hash).toBeNull();
      expect(afterLink.rows[0].email_verified_at).not.toBeNull();

      // La identidad de Google SÍ quedó vinculada a esta cuenta (REQ-173,
      // sin cambios de comportamiento ahí).
      const identity = await db.query<{ user_id: string }>(
        "select user_id from user_identities where subject = 'am01-google-sub-victima' and provider = 'google'"
      );
      expect(identity.rows[0]?.user_id).toBe(userId);

      // AUDIT: el evento de vinculación distingue este caso (estado
      // inconsistente detectado y corregido) de una vinculación limpia.
      const auditRows = await db.query<{ after: { accountWasSquatted?: boolean } }>(
        "select after from audit_log where actor_id = $1 and action = 'auth.google_linked' order by created_at desc limit 1",
        [userId]
      );
      expect(auditRows.rows[0]?.after?.accountWasSquatted).toBe(true);

      // 4) LA PRUEBA DECISIVA: el login del atacante con SU contraseña
      // original -- la única credencial que nunca tuvo que ver con la
      // víctima real -- ya no sirve, SIN que ninguna verificación nativa
      // haya tenido que ocurrir (email_verified_at ya lo marcó Google).
      const attackerLoginAfterLink = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: victimEmail, password: attackerPassword },
      });
      expect(attackerLoginAfterLink.statusCode).toBe(401);

      // La víctima, en cambio, sigue pudiendo entrar por Google con
      // normalidad (repetir el login con el mismo subject).
      const { state: state2, nonce: nonce2, codeChallenge: codeChallenge2 } = await startFlow();
      const code2 = provider.issueAuthorizationCode({
        sub: 'am01-google-sub-victima',
        email: victimEmail,
        emailVerified: true,
        aud: GOOGLE_CLIENT_ID,
        nonce: nonce2,
        codeChallenge: codeChallenge2,
      });
      const secondLogin = await app.inject({ method: 'GET', url: '/auth/google/callback', query: { code: code2, state: state2 } });
      expect(secondLogin.statusCode).toBe(200);
      expect(typeof secondLogin.json().accessToken).toBe('string');
    }
  );

  it('vinculación LIMPIA (cuenta ya verificada nativamente antes de usar Google) no se marca como squatteada', async () => {
    const email = 'am01-cuenta-limpia@example.com';
    const registerRes = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email, password: 'una-contrasena-cualquiera-123' },
    });
    expect(registerRes.statusCode).toBe(201);
    await app.waitForPendingMail();

    // Verificación nativa ANTES de usar Google -- estado consistente,
    // nunca hubo squatting que corregir.
    await db.query('update users set email_verified_at = now() where lower(email) = $1', [email]);
    const row = await db.query<{ id: string; password_hash: string | null }>('select id, password_hash from users where lower(email) = $1', [email]);
    const userId = row.rows[0].id;
    const passwordHashBefore = row.rows[0].password_hash;
    expect(passwordHashBefore).not.toBeNull();

    const { state, nonce, codeChallenge } = await startFlow();
    const code = provider.issueAuthorizationCode({
      sub: 'am01-google-sub-limpia',
      email,
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce,
      codeChallenge,
    });
    const callbackRes = await app.inject({ method: 'GET', url: '/auth/google/callback', query: { code, state } });
    expect(callbackRes.statusCode).toBe(200);

    // La contraseña real del dueño NUNCA debe invalidarse cuando no hubo
    // estado inconsistente que corregir.
    const afterLink = await db.query<{ password_hash: string | null }>('select password_hash from users where id = $1', [userId]);
    expect(afterLink.rows[0].password_hash).toBe(passwordHashBefore);

    const auditRows = await db.query<{ after: { accountWasSquatted?: boolean } }>(
      "select after from audit_log where actor_id = $1 and action = 'auth.google_linked' order by created_at desc limit 1",
      [userId]
    );
    expect(auditRows.rows[0]?.after?.accountWasSquatted).toBe(false);
  });
});
