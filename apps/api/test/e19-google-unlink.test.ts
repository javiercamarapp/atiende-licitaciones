import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor } from './helpers.js';

/**
 * E19/E21 (docs/BACKLOG.md): `POST /auth/google/unlink` -- desvincula la
 * identidad de Google de la cuenta propia. Exige step-up (mismo
 * `requireStepUp` que el resto de `apps/api`, purpose `auth.google_unlink`)
 * y nunca deja la cuenta sin ningún método de acceso: se rechaza (409) si
 * la cuenta no tiene contraseña propia.
 */
describe('E19: POST /auth/google/unlink', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function linkGoogleIdentity(userId: string, email: string): Promise<void> {
    await db.query(`insert into user_identities (user_id, provider, subject, email) values ($1, 'google', $2, $3)`, [
      userId,
      `google-sub-${userId}`,
      email,
    ]);
  }

  it('éxito: con step-up vigente y contraseña propia, desvincula Google y lo audita', async () => {
    const user = await registerAndLogin(app, 'e19-unlink-ok@example.com');
    const org = await createOrgFor(app, user, 'E19 Unlink Org', 'e19-unlink-org');
    await linkGoogleIdentity(user.id, user.email);
    const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'auth.google_unlink' });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/unlink',
      headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unlinked: true });

    const identityRows = await db.query("select 1 from user_identities where user_id = $1 and provider = 'google'", [user.id]);
    expect(identityRows.rows.length).toBe(0);

    const audit = await db.query<{ action: string; entity: string }>(
      "select action, entity from audit_log where action = 'auth.google_unlinked' and actor_id = $1",
      [user.id]
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].entity).toBe('auth');

    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${user.accessToken}` } });
    expect(me.json()).toMatchObject({ googleLinked: false, hasPassword: true });
  });

  it('rechazo sin step-up válido: falta el encabezado X-Step-Up (403), y la identidad sigue vinculada', async () => {
    const user = await registerAndLogin(app, 'e19-unlink-no-header@example.com');
    const org = await createOrgFor(app, user, 'E19 Unlink Org 2', 'e19-unlink-org-2');
    await linkGoogleIdentity(user.id, user.email);
    await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'auth.google_unlink' });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/unlink',
      headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id },
    });
    expect(res.statusCode).toBe(403);

    const identityRows = await db.query("select 1 from user_identities where user_id = $1 and provider = 'google'", [user.id]);
    expect(identityRows.rows.length).toBe(1);
  });

  it('rechazo (404) si la cuenta no tiene ninguna identidad de Google vinculada -- el stepUpToken se consume igual', async () => {
    const user = await registerAndLogin(app, 'e19-unlink-no-identity@example.com');
    const org = await createOrgFor(app, user, 'E19 Unlink Org 3', 'e19-unlink-org-3');
    const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'auth.google_unlink' });

    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/unlink',
      headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
    });
    expect(res.statusCode).toBe(404);

    const session = await db.query<{ consumed_at: string | null }>('select consumed_at from step_up_sessions where id = $1', [stepUpToken]);
    expect(session.rows.length).toBe(1);
    expect(session.rows[0].consumed_at).not.toBeNull();
  });

  it('rechazo (409) si desvincular dejaría la cuenta sin ningún método de acceso (sin contraseña) -- Google sigue vinculado y el stepUpToken se consume igual', async () => {
    const user = await registerAndLogin(app, 'e19-unlink-no-access@example.com');
    const org = await createOrgFor(app, user, 'E19 Unlink Org 4', 'e19-unlink-org-4');
    await linkGoogleIdentity(user.id, user.email);
    const { stepUpToken } = await enrollTwoFactor(app, user.accessToken, { orgId: org.id, purpose: 'auth.google_unlink' });

    // Simula una cuenta solo-Google (REQ-172, `password_hash is null`) --
    // directo en DB, como propietario (bypassa RLS), igual que el resto de
    // setup de este archivo de tests.
    await db.query('update users set password_hash = null where id = $1', [user.id]);

    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/unlink',
      headers: { authorization: `Bearer ${user.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
    });
    expect(res.statusCode).toBe(409);

    const identityRows = await db.query("select 1 from user_identities where user_id = $1 and provider = 'google'", [user.id]);
    expect(identityRows.rows.length).toBe(1);

    const session = await db.query<{ consumed_at: string | null }>('select consumed_at from step_up_sessions where id = $1', [stepUpToken]);
    expect(session.rows.length).toBe(1);
    expect(session.rows[0].consumed_at).not.toBeNull();
  });

  it('sin autenticación: 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/google/unlink' });
    expect(res.statusCode).toBe(401);
  });

  it('GET /me: refleja hasPassword/googleLinked reales de la cuenta', async () => {
    const user = await registerAndLogin(app, 'e19-me-flags@example.com');

    const before = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${user.accessToken}` } });
    expect(before.json()).toMatchObject({ hasPassword: true, googleLinked: false });

    await linkGoogleIdentity(user.id, user.email);
    const after = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${user.accessToken}` } });
    expect(after.json()).toMatchObject({ hasPassword: true, googleLinked: true });
  });
});
