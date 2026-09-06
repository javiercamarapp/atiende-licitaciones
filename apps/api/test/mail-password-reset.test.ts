import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';
import { allMail, lastMailTo, signedParamsFrom, urlFrom } from './helpers/mail.js';

/**
 * REQ-186 (enlaces firmados con expiración, rechazados en servidor si están
 * vencidos o alterados) + paridad Ronda G: recuperación de contraseña con
 * token de un solo uso, hasheado en base, y revocación de TODAS las sesiones
 * al completarla.
 */
describe('REQ-186: recuperación de contraseña', () => {
  let app: FastifyInstance;
  let db: DbClient;
  const EMAIL = 'reset@example.com';
  const PASSWORD = 'super-secret-password';
  const NUEVA = 'una-contrasena-nueva-larga';

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function pedirEnlace(email = EMAIL): Promise<{ d: string; s: string }> {
    const res = await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email } });
    expect(res.statusCode).toBe(202);
    return signedParamsFrom(await lastMailTo(app, email), '/restablecer-contrasena');
  }

  it('flujo completo: solicitar -> restablecer -> la contraseña vieja deja de servir y TODA sesión previa queda revocada', async () => {
    const usuario = await registerAndLogin(app, EMAIL, PASSWORD);

    const params = await pedirEnlace();
    const correo = await lastMailTo(app, EMAIL);
    // Asunto real de la plantilla `password-reset` (packages/mail, alineado
    // a REQ-181 plantilla 3): "Recupera tu acceso a Atiende Licitaciones".
    expect(correo.subject.toLowerCase()).toContain('recupera tu acceso');
    expect(urlFrom(correo, '/restablecer-contrasena').origin).toBe(new URL(app.config.publicUrl).origin);

    const reset = await app.inject({ method: 'POST', url: '/auth/password/reset', payload: { ...params, newPassword: NUEVA } });
    expect(reset.statusCode).toBe(200);

    // La sesión anterior (refresh token emitido antes del reset) ya no sirve:
    // `app.reset_password_with_token` revoca la familia completa (0084).
    const refresh = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: usuario.refreshToken } });
    expect(refresh.statusCode).toBe(401);

    const vieja = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } });
    expect(vieja.statusCode).toBe(401);

    const nueva = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: NUEVA } });
    expect(nueva.statusCode).toBe(200);

    const audit = await db.query<{ action: string; actor_id: string | null }>(
      "select action, actor_id from audit_log where action in ('auth.password_reset_requested', 'auth.password_reset_completed') order by action"
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['auth.password_reset_completed', 'auth.password_reset_requested']);
    expect(audit.rows.every((r) => r.actor_id === usuario.id)).toBe(true);
  });

  it('el token vive HASHEADO en la base: el valor en claro solo existe dentro del correo', async () => {
    const usuario = await registerAndLogin(app, EMAIL, PASSWORD);
    const params = await pedirEnlace();
    const payload = JSON.parse(Buffer.from(params.d, 'base64url').toString('utf8')) as { token: string };

    const { rows } = await db.query<{ token_hash: string }>('select token_hash from password_reset_tokens where user_id = $1', [usuario.id]);
    expect(rows.length).toBe(1);
    expect(rows[0].token_hash).not.toBe(payload.token);
    expect(rows[0].token_hash).toHaveLength(64); // sha256 hex
  });

  it('ANTI-ENUMERACIÓN: la respuesta es idéntica byte a byte exista o no la cuenta, y no se manda correo a una inexistente', async () => {
    await registerAndLogin(app, EMAIL, PASSWORD);
    const antes = (await allMail(app)).length;

    const inexistente = await app.inject({
      method: 'POST',
      url: '/auth/password/forgot',
      payload: { email: 'nunca-registrado@example.com' },
    });
    await app.waitForPendingMail();
    expect((await allMail(app)).length).toBe(antes);

    const existente = await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: EMAIL } });
    await app.waitForPendingMail();

    expect(existente.statusCode).toBe(inexistente.statusCode);
    expect(existente.body).toBe(inexistente.body);
    expect((await allMail(app)).length).toBe(antes + 1);
  });

  it('ADVERSARIAL: el enlace de restablecimiento es de UN SOLO USO', async () => {
    await registerAndLogin(app, EMAIL, PASSWORD);
    const params = await pedirEnlace();

    expect((await app.inject({ method: 'POST', url: '/auth/password/reset', payload: { ...params, newPassword: NUEVA } })).statusCode).toBe(200);

    const segunda = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { ...params, newPassword: 'otra-contrasena-del-atacante' },
    });
    expect(segunda.statusCode).toBe(400);

    // La contraseña que quedó es la del PRIMER uso, no la del segundo intento.
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: NUEVA } })).statusCode).toBe(200);
  });

  it('ADVERSARIAL: firma manipulada y enlace vencido -> 400, sin cambiar la contraseña', async () => {
    await registerAndLogin(app, EMAIL, PASSWORD);
    const params = await pedirEnlace();

    const firmaMala = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { d: params.d, s: `${params.s.slice(0, -2)}AA`, newPassword: NUEVA },
    });
    expect(firmaMala.statusCode).toBe(400);

    const decoded = JSON.parse(Buffer.from(params.d, 'base64url').toString('utf8')) as { resetId: string; token: string };
    const vencido = new URL(
      app.mail.signedLink(app.config.publicUrl, '/restablecer-contrasena', { resetId: decoded.resetId, token: decoded.token }, -60)
    );
    const expirado = await app.inject({
      method: 'POST',
      url: '/auth/password/reset',
      payload: { d: vencido.searchParams.get('d')!, s: vencido.searchParams.get('s')!, newPassword: NUEVA },
    });
    expect(expirado.statusCode).toBe(400);
    expect(expirado.json().title).toBe(firmaMala.json().title); // mismo mensaje, sin distinguir el motivo

    // La contraseña original sigue vigente y el token sigue SIN consumir.
    expect((await app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } })).statusCode).toBe(200);
    const { rows } = await db.query<{ consumed_at: string | null }>('select consumed_at from password_reset_tokens');
    expect(rows.every((r) => r.consumed_at === null)).toBe(true);
  });

  it('ADVERSARIAL: el enlace de una cuenta no cambia la contraseña de OTRA', async () => {
    await registerAndLogin(app, EMAIL, PASSWORD);
    const otra = await registerAndLogin(app, 'otra-cuenta@example.com', PASSWORD);

    const params = await pedirEnlace(EMAIL);
    expect((await app.inject({ method: 'POST', url: '/auth/password/reset', payload: { ...params, newPassword: NUEVA } })).statusCode).toBe(200);

    // La otra cuenta conserva su contraseña y su sesión.
    const { rows } = await db.query<{ id: string; password_hash: string }>('select id, password_hash from users where id = $1', [otra.id]);
    expect(rows[0].password_hash).toBeTruthy();
    const meOtra = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${otra.accessToken}` } });
    expect(meOtra.statusCode).toBe(200);
  });

  it('una cuenta creada SOLO con Google (sin contraseña propia) no recibe enlace, con la misma respuesta 202', async () => {
    await db.query(
      "insert into users (id, email, password_hash, full_name, email_verified_at) values (gen_random_uuid(), $1, null, 'Solo Google', now())",
      ['solo-google@example.com']
    );
    const antes = (await allMail(app)).length;

    const res = await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'solo-google@example.com' } });
    await app.waitForPendingMail();

    expect(res.statusCode).toBe(202);
    expect((await allMail(app)).length).toBe(antes);
  });

  it('la solicitud está acotada por el tier `auth` (5/min): el 6º intento del minuto es 429', async () => {
    const respuestas = [];
    for (let i = 0; i < 6; i++) {
      respuestas.push(await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: `rl-reset-${i}@example.com` } }));
    }
    expect(respuestas.slice(0, 5).every((r) => r.statusCode === 202)).toBe(true);
    expect(respuestas[5].statusCode).toBe(429);
  });
});
