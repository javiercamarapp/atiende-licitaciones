import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor } from './helpers.js';
import { lastMailTo, signedParamsFrom } from './helpers/mail.js';

/**
 * AM-05 (docs/auditoria-2/api-mail.md, MEDIA): `recordAuthAudit`/
 * `app.record_auth_event` nunca aceptaban `correlationId`, así que
 * `audit_log.correlation_id` quedaba SIEMPRE NULL para TODA la familia
 * `auth.*` -- incluidas las cuatro acciones de correo en el alcance de esta
 * ronda (`auth.email_verification_sent`, `auth.email_verified`,
 * `auth.password_reset_requested`, `auth.password_reset_completed`).
 * Cerrado por 0096_req177_auth_event_correlation_id.sql +
 * `recordAuthAudit`/`issueTokenPair` propagando `request.correlationId`
 * (REQ-171) hasta la función SQL (commit c98bb30, REQ-175/REQ-177).
 *
 * `security-api13-auth-audit-log.test.ts` y
 * `audit-req175-google-refresh-parity.test.ts` ya cubren login/refresh/
 * logout/google_login con `X-Correlation-Id`; este archivo cierra la
 * brecha DE PRUEBA que quedaba sobre el resto de la familia -- en
 * particular las cuatro acciones de correo -- y añade una comprobación
 * GENÉRICA que falla si CUALQUIER evento `auth.*` insertado durante estas
 * pruebas queda con `correlation_id` NULL, para que una regresión futura
 * (un nuevo call site de `recordAuthAudit` que olvide propagar
 * `correlationId`) no pueda colarse en silencio.
 */
describe('AM-05: correlation_id se propaga en toda la familia auth.* (correo incluido)', () => {
  let app: FastifyInstance;
  let db: DbClient;
  const CORRELATION_ID = '33333333-3333-4333-8333-333333333333';

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function correlationIdFor(action: string, actorId?: string): Promise<(string | null)[]> {
    const { rows } = actorId
      ? await db.query<{ correlation_id: string | null }>(
          'select correlation_id from audit_log where entity = $1 and action = $2 and actor_id = $3',
          ['auth', action, actorId]
        )
      : await db.query<{ correlation_id: string | null }>('select correlation_id from audit_log where entity = $1 and action = $2', [
          'auth',
          action,
        ]);
    return rows.map((r) => r.correlation_id);
  }

  it('las cuatro acciones de correo (email_verification_sent/email_verified/password_reset_requested/password_reset_completed) llevan el X-Correlation-Id de la request', async () => {
    const EMAIL = 'am05-correo@example.com';
    const PASSWORD = 'super-secret-password';

    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: EMAIL, password: PASSWORD } });
    expect(reg.statusCode).toBe(201);
    const userId = reg.json().id as string;

    // auth.email_verification_sent (reenvío, anónimo -- REQ-181..195/AM-02).
    const resend = await app.inject({
      method: 'POST',
      url: '/auth/email/resend-verification',
      headers: { 'x-correlation-id': CORRELATION_ID },
      payload: { email: EMAIL },
    });
    expect(resend.statusCode).toBe(202);
    await lastMailTo(app, EMAIL);
    expect(await correlationIdFor('auth.email_verification_sent', userId)).toEqual([CORRELATION_ID]);

    // auth.email_verified (consumir el enlace firmado del reenvío).
    const verifyParams = signedParamsFrom(await lastMailTo(app, EMAIL), '/verificar-correo');
    const verify = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      headers: { 'x-correlation-id': CORRELATION_ID },
      payload: verifyParams,
    });
    expect(verify.statusCode).toBe(200);
    expect(await correlationIdFor('auth.email_verified', userId)).toEqual([CORRELATION_ID]);

    // auth.password_reset_requested (anónimo -- AM-02).
    const forgot = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      headers: { 'x-correlation-id': CORRELATION_ID },
      payload: { email: EMAIL },
    });
    expect(forgot.statusCode).toBe(202);
    await lastMailTo(app, EMAIL);
    expect(await correlationIdFor('auth.password_reset_requested', userId)).toEqual([CORRELATION_ID]);

    // auth.password_reset_completed.
    const resetParams = signedParamsFrom(await lastMailTo(app, EMAIL), '/restablecer-contrasena');
    const reset = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      headers: { 'x-correlation-id': CORRELATION_ID },
      payload: { ...resetParams, newPassword: 'una-contrasena-nueva-larga' },
    });
    expect(reset.statusCode).toBe(200);
    expect(await correlationIdFor('auth.password_reset_completed', userId)).toEqual([CORRELATION_ID]);
  });

  it('auth.session_revoked y auth.sessions_revoked_others también llevan correlation_id', async () => {
    const usuario = await registerAndLogin(app, 'am05-sesiones@example.com');
    const otra = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: usuario.email, password: usuario.password },
    });
    expect(otra.statusCode).toBe(200);

    const list = await app.inject({ method: 'GET', url: '/auth/sessions', headers: { authorization: `Bearer ${usuario.accessToken}` } });
    const sessionId = list.json().sessions[0].id as string;

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/auth/sessions/${sessionId}`,
      headers: { authorization: `Bearer ${usuario.accessToken}`, 'x-correlation-id': CORRELATION_ID },
    });
    expect(revoke.statusCode).toBe(200);
    expect(await correlationIdFor('auth.session_revoked', usuario.id)).toEqual([CORRELATION_ID]);

    const revokeOthers = await app.inject({
      method: 'POST',
      url: '/auth/sessions/revoke-others',
      headers: { authorization: `Bearer ${usuario.accessToken}`, 'x-correlation-id': CORRELATION_ID },
      payload: { refreshToken: usuario.refreshToken },
    });
    expect(revokeOthers.statusCode).toBe(200);
    expect(await correlationIdFor('auth.sessions_revoked_others', usuario.id)).toEqual([CORRELATION_ID]);
  });

  it('auth.password_changed lleva correlation_id', async () => {
    const usuario = await registerAndLogin(app, 'am05-cambio@example.com');
    const org = await createOrgFor(app, usuario, 'AM-05 Org', 'am05-org');
    const { stepUpToken } = await enrollTwoFactor(app, usuario.accessToken, { orgId: org.id, purpose: 'auth.password_change' });

    const change = await app.inject({
      method: 'POST',
      url: '/auth/password/change',
      headers: {
        authorization: `Bearer ${usuario.accessToken}`,
        'x-org-id': org.id,
        'x-step-up': stepUpToken,
        'x-correlation-id': CORRELATION_ID,
      },
      payload: { currentPassword: usuario.password, newPassword: 'una-contrasena-nueva-larga-2' },
    });
    expect(change.statusCode).toBe(200);
    expect(await correlationIdFor('auth.password_changed', usuario.id)).toEqual([CORRELATION_ID]);
  });

  it('ningún evento auth.* insertado durante esta suite queda con correlation_id NULL (red de seguridad genérica)', async () => {
    // Ejercita varias rutas SIN cabecera explícita -- `correlation-id.plugin.ts`
    // (REQ-171) genera un UUID por request, así que "sin cabecera" tampoco
    // debe dejar NULL (ver security-api13-auth-audit-log.test.ts).
    const EMAIL = 'am05-generico@example.com';
    const PASSWORD = 'super-secret-password';
    await app.inject({ method: 'POST', url: '/auth/register', payload: { email: EMAIL, password: PASSWORD } });
    await app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: 'contrasena-equivocada' } });
    await app.inject({ method: 'POST', url: '/auth/email/resend-verification', payload: { email: EMAIL } });
    await lastMailTo(app, EMAIL);
    await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: EMAIL } });
    await lastMailTo(app, EMAIL);
    await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'no-existe-nunca@example.com' } });

    const { rows } = await db.query<{ action: string; correlation_id: string | null }>(
      "select action, correlation_id from audit_log where entity = 'auth'"
    );
    expect(rows.length).toBeGreaterThan(0);
    const nulos = rows.filter((r) => r.correlation_id === null);
    expect(nulos).toEqual([]);
  });
});
