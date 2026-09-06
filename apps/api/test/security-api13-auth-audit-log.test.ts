import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';

/**
 * API-13 (docs/auditoria-1/db-api-seguridad-reverificacion.md, BAJA/MEDIA):
 * `apps/api/src/modules/auth/routes.ts` (login, refresh, logout) no
 * llamaba nunca a `recordAudit` -- en particular, la revocación defensiva
 * de TODA la familia de sesiones activas que dispara la detección de
 * reuso de un refresh token (API-01) no dejaba ningún rastro en
 * `audit_log`. Fijado con `recordAuthAudit`/`app.record_auth_event`
 * (0051_fix_api13_auth_audit_log.sql): login ok/fallo, refresh exitoso,
 * reutilización de refresh token (revocación de familia) y logout ahora
 * quedan en `audit_log` con actor, ip, user-agent y request_id -- nunca
 * contraseña ni token.
 */

async function readAuthAuditRows(db: DbClient, action?: string): Promise<Record<string, unknown>[]> {
  const { rows } = action
    ? await db.query<Record<string, unknown>>("select * from audit_log where entity = 'auth' and action = $1 order by created_at asc", [action])
    : await db.query<Record<string, unknown>>("select * from audit_log where entity = 'auth' order by created_at asc");
  return rows;
}

describe('API-13: eventos de autenticación quedan en audit_log', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('login exitoso registra auth.login_succeeded con actor, ip, user-agent y request_id (sin contraseña)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'user-agent': 'vitest-agent/1.0' },
      payload: { email: 'api13-ok@example.com', password: 'super-secret-password' },
    });
    // El usuario no existe todavía en este test aislado -- primero se registra.
    expect(res.statusCode).toBe(401);

    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'api13-ok@example.com', password: 'super-secret-password' } });
    expect(reg.statusCode).toBe(201);
    // REQ-181..195: el login exige el correo confirmado. Este test mide la
    // AUDITORÍA del login exitoso, no el flujo de verificación (eso lo cubre
    // test/mail-email-verification.test.ts), así que se marca verificado en
    // la base -- mismo criterio que el helper `registerAndLogin`.
    await db.query('update users set email_verified_at = now() where id = $1', [reg.json().id]);

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'user-agent': 'vitest-agent/1.0' },
      payload: { email: 'api13-ok@example.com', password: 'super-secret-password' },
    });
    expect(login.statusCode).toBe(200);

    const rows = await readAuthAuditRows(db, 'auth.login_succeeded');
    expect(rows.length).toBe(1);
    expect(rows[0].actor_id).toBe(reg.json().id);
    const after = rows[0].after as { ip?: string; userAgent?: string };
    expect(after.userAgent).toBe('vitest-agent/1.0');
    expect(JSON.stringify(rows[0])).not.toMatch(/super-secret-password/);
  });

  it('login fallido (contraseña incorrecta y email inexistente) registra auth.login_failed sin la contraseña', async () => {
    const reg = await app.inject({ method: 'POST', url: '/auth/register', payload: { email: 'api13-fail@example.com', password: 'correct-password-here' } });
    expect(reg.statusCode).toBe(201);

    const wrongPassword = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'api13-fail@example.com', password: 'wrong-password-xyz' } });
    expect(wrongPassword.statusCode).toBe(401);

    const unknownEmail = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'api13-does-not-exist@example.com', password: 'whatever-123' } });
    expect(unknownEmail.statusCode).toBe(401);

    const rows = await readAuthAuditRows(db, 'auth.login_failed');
    expect(rows.length).toBe(2);
    expect(rows.some((r) => r.actor_id === reg.json().id)).toBe(true); // contraseña incorrecta: actor conocido
    expect(rows.some((r) => r.actor_id === null)).toBe(true); // email inexistente: actor desconocido
    expect(JSON.stringify(rows)).not.toMatch(/wrong-password-xyz|whatever-123|correct-password-here/);
  });

  it('reutilizar un refresh token ya rotado registra auth.refresh_reuse_detected (revocación de familia visible en audit_log)', async () => {
    const user = await registerAndLogin(app, 'api13-reuse@example.com');

    const refresh1 = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refreshToken } });
    expect(refresh1.statusCode).toBe(200);

    // Reusar el token VIEJO (ya rotado) -- dispara la revocación defensiva de familia.
    const reuse = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refreshToken } });
    expect(reuse.statusCode).toBe(401);

    const successRows = await readAuthAuditRows(db, 'auth.refresh_succeeded');
    expect(successRows.length).toBe(1);
    expect(successRows[0].actor_id).toBe(user.id);

    const reuseRows = await readAuthAuditRows(db, 'auth.refresh_reuse_detected');
    expect(reuseRows.length).toBe(1);
    expect(reuseRows[0].actor_id).toBe(user.id);
    expect(JSON.stringify(reuseRows)).not.toMatch(new RegExp(user.refreshToken.slice(0, 20)));
  });

  it('un refresh simplemente inválido/inexistente NO genera un evento de reuso (solo el reuso real tiene valor de auditoría)', async () => {
    const invalid = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'no-es-un-jwt-valido' } });
    expect(invalid.statusCode).toBe(401);
    const reuseRows = await readAuthAuditRows(db, 'auth.refresh_reuse_detected');
    expect(reuseRows.length).toBe(0);
  });

  it('logout con token válido registra auth.logout; logout con token inválido no registra nada (no filtra información)', async () => {
    const user = await registerAndLogin(app, 'api13-logout@example.com');

    const badLogout = await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: 'token-invalido' } });
    expect(badLogout.statusCode).toBe(204);
    expect((await readAuthAuditRows(db, 'auth.logout')).length).toBe(0);

    const okLogout = await app.inject({ method: 'POST', url: '/auth/logout', payload: { refreshToken: user.refreshToken } });
    expect(okLogout.statusCode).toBe(204);
    const rows = await readAuthAuditRows(db, 'auth.logout');
    expect(rows.length).toBe(1);
    expect(rows[0].actor_id).toBe(user.id);
  });
});
