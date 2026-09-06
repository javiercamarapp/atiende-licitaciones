import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactorFull } from './helpers.js';
import { startFakeOidcProvider, parseAuthorizationUrl, type FakeOidcProvider } from './helpers/fake-oidc.js';

/**
 * REQ-172..180 (docs/REQUISITOS.md §34.1) / docs/ACEPTACION.md S1-S3:
 * suite de integración de login con Google usando un proveedor OIDC FALSO
 * real (`test/helpers/fake-oidc.ts`, servidor HTTP local, JWKS/discovery/
 * token endpoint reales, firma RS256 con clave de prueba) -- nunca contra
 * la red real ni credenciales de Google.
 *
 * Un solo proveedor falso + una sola app Fastify + una sola base PGlite
 * para todo el archivo (más barato que recrearlos por test, ver patrón
 * `beforeAll`/`afterAll` de otros archivos de este mismo directorio); cada
 * test usa un email/subject único para no colisionar entre sí.
 */
describe('REQ-172..180: login con Google (OIDC falso)', () => {
  const GOOGLE_CLIENT_ID = 'test-google-client-id';
  const GOOGLE_CLIENT_SECRET = 'test-google-client-secret-not-real';
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
    // Este archivo ejerce `/auth/google/start`/`/auth/google/callback`
    // (tier `auth`, 5/min por defecto) muchas veces en pocos segundos --
    // mismo perfil `e2e` que ya usan otras suites intensivas de este
    // directorio (ver `ronda4-rate-limit-profile.test.ts`,
    // `security-r502-r503-twofa-brute-force.test.ts`) para no confundir el
    // propio volumen de la suite con un fallo de producto real.
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

  async function callback(code: string | undefined, state: string) {
    const query: Record<string, string> = { state };
    if (code) query.code = code;
    return app.inject({ method: 'GET', url: '/auth/google/callback', query });
  }

  it('S1: login con Google de un email nunca antes registrado crea usuario y entra por invitación pendiente (REQ-172/174/177)', async () => {
    const owner = await registerAndLogin(app, 's1-owner@example.com');
    const org = await createOrgFor(app, owner, 'Org S1', `org-s1-${Date.now()}`);
    const invite = await app.inject({
      method: 'POST',
      url: '/organizations/invitations',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { email: 's1-nuevo@example.com', role: 'viewer' },
    });
    expect(invite.statusCode).toBe(201);

    const { state, nonce, codeChallenge } = await startFlow();
    const code = provider.issueAuthorizationCode({
      sub: 'google-sub-s1',
      email: 's1-nuevo@example.com',
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce,
      codeChallenge,
    });
    const res = await callback(code, state);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(typeof body.accessToken).toBe('string');
    expect(typeof body.refreshToken).toBe('string');

    const userRow = await db.query<{ id: string; password_hash: string | null }>(
      "select id, password_hash from users where lower(email) = 's1-nuevo@example.com'"
    );
    expect(userRow.rows.length).toBe(1);
    expect(userRow.rows[0].password_hash).toBeNull();
    const userId = userRow.rows[0].id;

    const identityRow = await db.query("select user_id from user_identities where subject = 'google-sub-s1' and provider = 'google'");
    expect(identityRow.rows.length).toBe(1);
    expect(identityRow.rows[0].user_id).toBe(userId);

    const membershipRow = await db.query<{ role: string }>('select role from memberships where org_id = $1 and user_id = $2', [org.id, userId]);
    expect(membershipRow.rows[0]?.role).toBe('viewer');

    const invitationRow = await db.query<{ status: string }>("select status from invitations where lower(email) = 's1-nuevo@example.com'");
    expect(invitationRow.rows[0]?.status).toBe('accepted');

    const auditRows = await db.query("select 1 from audit_log where actor_id = $1 and action = 'auth.google_login'", [userId]);
    expect(auditRows.rows.length).toBeGreaterThan(0);

    // El acceso emitido funciona como cualquier otra sesión (REQ-175).
    const myOrgs = await app.inject({ method: 'GET', url: '/organizations', headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(myOrgs.statusCode).toBe(200);
    expect(myOrgs.json()).toHaveLength(1);
  });

  it('S2: login con Google vincula automáticamente una cuenta existente por email verificado, sin duplicar (REQ-173)', async () => {
    const existing = await registerAndLogin(app, 's2-existing@example.com');

    const { state, nonce, codeChallenge } = await startFlow();
    const code = provider.issueAuthorizationCode({
      sub: 'google-sub-s2',
      email: 's2-existing@example.com',
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce,
      codeChallenge,
    });
    const res = await callback(code, state);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('sin_acceso'); // cuenta email+contraseña sin organización propia en este test

    const identity = await db.query<{ user_id: string }>("select user_id from user_identities where subject = 'google-sub-s2'");
    expect(identity.rows[0]?.user_id).toBe(existing.id);

    const linked = await db.query("select 1 from audit_log where actor_id = $1 and action = 'auth.google_linked'", [existing.id]);
    expect(linked.rows.length).toBe(1);

    const usersWithEmail = await db.query<{ c: string }>("select count(*)::text as c from users where lower(email) = 's2-existing@example.com'");
    expect(usersWithEmail.rows[0].c).toBe('1');

    // Repetir el login con Google (mismo subject) vuelve a autenticar sin crear una segunda identidad.
    const { state: state2, nonce: nonce2, codeChallenge: codeChallenge2 } = await startFlow();
    const code2 = provider.issueAuthorizationCode({
      sub: 'google-sub-s2',
      email: 's2-existing@example.com',
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce: nonce2,
      codeChallenge: codeChallenge2,
    });
    const res2 = await callback(code2, state2);
    expect(res2.statusCode).toBe(200);
    const identityCount = await db.query<{ c: string }>("select count(*)::text as c from user_identities where subject = 'google-sub-s2'");
    expect(identityCount.rows[0].c).toBe('1');
  });

  it('S3: email no verificado se rechaza explícitamente -- 0 cuentas creadas, 0 vinculaciones (REQ-179)', async () => {
    const before = await db.query<{ c: string }>("select count(*)::text as c from users where lower(email) = 's3-no-verificado@example.com'");
    expect(before.rows[0].c).toBe('0');

    const { state, nonce, codeChallenge } = await startFlow();
    const code = provider.issueAuthorizationCode({
      sub: 'google-sub-s3',
      email: 's3-no-verificado@example.com',
      emailVerified: false,
      aud: GOOGLE_CLIENT_ID,
      nonce,
      codeChallenge,
    });
    const res = await callback(code, state);
    expect(res.statusCode).toBe(403);

    const after = await db.query<{ c: string }>("select count(*)::text as c from users where lower(email) = 's3-no-verificado@example.com'");
    expect(after.rows[0].c).toBe('0');

    const rejected = await db.query("select 1 from audit_log where action = 'auth.google_rejected' order by created_at desc limit 1");
    expect(rejected.rows.length).toBe(1);
  });

  it('ADVERSARIAL: state inválido (garbage, sin firma real) responde 400 y no crea nada', async () => {
    const res = await callback('cualquier-codigo', 'esto-no-es-un-jwt-valido');
    expect(res.statusCode).toBe(400);
  });

  it('ADVERSARIAL: state expirado (TTL de oauth_states vencido) responde 400', async () => {
    const { state } = await startFlow();
    const row = await db.query<{ id: string }>('select id from oauth_states order by created_at desc limit 1');
    expect(row.rows.length).toBe(1);
    await db.query("update oauth_states set expires_at = now() - interval '1 hour' where id = $1", [row.rows[0].id]);

    const res = await callback('cualquier-codigo', state);
    expect(res.statusCode).toBe(400);
  });

  it('ADVERSARIAL: state/nonce reutilizado (doble callback con el mismo state) responde 400 en el segundo intento', async () => {
    const { state, nonce, codeChallenge } = await startFlow();
    const code = provider.issueAuthorizationCode({
      sub: 'google-sub-replay',
      email: 'replay@example.com',
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce,
      codeChallenge,
    });
    const first = await callback(code, state);
    expect(first.statusCode).toBe(200);

    // Mismo `state` (y por tanto mismo `nonce` embebido en la fila ya
    // consumida) reutilizado en un segundo intento -- reemitir un `code`
    // nuevo no ayuda: la fila de `oauth_states` ya está consumida.
    const code2 = provider.issueAuthorizationCode({
      sub: 'google-sub-replay',
      email: 'replay@example.com',
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce,
      codeChallenge,
    });
    const second = await callback(code2, state);
    expect(second.statusCode).toBe(400);
  });

  it('ADVERSARIAL: id_token con aud ajeno (de otro cliente) responde 401', async () => {
    const { state, nonce, codeChallenge } = await startFlow();
    const code = provider.issueAuthorizationCode({
      sub: 'google-sub-aud',
      email: 'aud-ajeno@example.com',
      emailVerified: true,
      aud: 'algun-otro-client-id.apps.googleusercontent.com',
      nonce,
      codeChallenge,
    });
    const res = await callback(code, state);
    expect(res.statusCode).toBe(401);

    const created = await db.query<{ c: string }>("select count(*)::text as c from users where lower(email) = 'aud-ajeno@example.com'");
    expect(created.rows[0].c).toBe('0');
  });

  it('usuario con 2FA activo: login con Google exige el mismo segundo factor antes de completar la sesión (REQ-176)', async () => {
    const user = await registerAndLogin(app, 's-2fa@example.com');
    const org = await createOrgFor(app, user, 'Org 2FA', `org-2fa-${Date.now()}`);
    // Se usa un código de RESPALDO (no el TOTP recién consumido por
    // `enrollTwoFactorFull` para emitir su propio `stepUpToken`) -- un
    // código TOTP generado inmediatamente después caería casi siempre en
    // el MISMO "time step" de 30s ya consumido y el anti-replay lo
    // rechazaría (mismo criterio documentado en `test/helpers.ts` sobre
    // `stepUpWithBackupCode`).
    const { backupCodes } = await enrollTwoFactorFull(app, user.accessToken, { orgId: org.id, purpose: 'company.rate_approval' });

    const { state, nonce, codeChallenge } = await startFlow();
    const code = provider.issueAuthorizationCode({
      sub: 'google-sub-2fa',
      email: 's-2fa@example.com',
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce,
      codeChallenge,
    });
    const res = await callback(code, state);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('requires_2fa');
    expect(typeof body.pendingToken).toBe('string');
    expect(body.accessToken).toBeUndefined();

    const verify = await app.inject({
      method: 'POST',
      url: '/auth/google/verify-2fa',
      payload: { pendingToken: body.pendingToken, code: backupCodes[0] },
    });
    expect(verify.statusCode).toBe(200);
    const verifyBody = verify.json();
    expect(verifyBody.status).toBe('ok');
    expect(typeof verifyBody.accessToken).toBe('string');

    const loginAudit = await db.query("select 1 from audit_log where actor_id = $1 and action = 'auth.google_login'", [user.id]);
    expect(loginAudit.rows.length).toBeGreaterThan(0);
  });

  it('usuario nuevo sin invitación pendiente: compuerta sin_acceso (sin organización automática) (REQ-172/174/180)', async () => {
    const { state, nonce, codeChallenge } = await startFlow();
    const code = provider.issueAuthorizationCode({
      sub: 'google-sub-sinacceso',
      email: 'sin-acceso@example.com',
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce,
      codeChallenge,
    });
    const res = await callback(code, state);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('sin_acceso');
    expect(typeof body.accessToken).toBe('string');

    const orgs = await app.inject({ method: 'GET', url: '/organizations', headers: { authorization: `Bearer ${body.accessToken}` } });
    expect(orgs.statusCode).toBe(200);
    expect(orgs.json()).toHaveLength(0);
  });

  it('ADVERSARIAL (REQ-180): un segundo subject de Google para el mismo email ya vinculado se rechaza como conflicto', async () => {
    const owner = await registerAndLogin(app, 's-conflicto@example.com');

    const first = await startFlow();
    const code1 = provider.issueAuthorizationCode({
      sub: 'google-sub-conflicto-A',
      email: 's-conflicto@example.com',
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce: first.nonce,
      codeChallenge: first.codeChallenge,
    });
    const res1 = await callback(code1, first.state);
    expect(res1.statusCode).toBe(200);

    const second = await startFlow();
    const code2 = provider.issueAuthorizationCode({
      sub: 'google-sub-conflicto-B',
      email: 's-conflicto@example.com',
      emailVerified: true,
      aud: GOOGLE_CLIENT_ID,
      nonce: second.nonce,
      codeChallenge: second.codeChallenge,
    });
    const res2 = await callback(code2, second.state);
    expect(res2.statusCode).toBe(403);

    const identities = await db.query<{ c: string }>('select count(*)::text as c from user_identities where user_id = $1', [owner.id]);
    expect(identities.rows[0].c).toBe('1');

    const rejected = await db.query("select 1 from audit_log where actor_id = $1 and action = 'auth.google_rejected'", [owner.id]);
    expect(rejected.rows.length).toBe(1);
  });

  it('GET /auth/google/start devuelve una URL de autorización real del proveedor OIDC configurado (PKCE + state + nonce)', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/google/start' });
    expect(res.statusCode).toBe(200);
    const { authorizationUrl } = res.json();
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe(provider.issuerUrl);
    expect(url.searchParams.get('client_id')).toBe(GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(GOOGLE_REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
  });
});
