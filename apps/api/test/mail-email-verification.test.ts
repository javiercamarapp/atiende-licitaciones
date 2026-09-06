import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';
import { allMail, lastMailTo, signedParamsFrom, urlFrom } from './helpers/mail.js';

/**
 * REQ-181..195 / S4 (docs/ACEPTACION.md): verificación de correo al
 * registrarse -- envío, confirmación de un solo uso, reenvío acotado y la
 * compuerta de `POST /auth/login`.
 *
 * Todas las pruebas usan el `CaptureProvider` (ningún `MAIL_PROVIDER`
 * definido, ver `test/helpers/mail.ts`): el correo NUNCA sale a la red, y
 * aun así se verifica su contenido real -- asunto, enlace firmado y el hecho
 * de que el token en claro solo existe dentro del mensaje.
 */
describe('S4/REQ-181: verificación de correo', () => {
  let app: FastifyInstance;
  let db: DbClient;
  const EMAIL = 'verificacion@example.com';
  const PASSWORD = 'super-secret-password';

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function register(email = EMAIL, password = PASSWORD): Promise<string> {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password } });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  }

  it('el registro manda el correo de verificación con un enlace FIRMADO y el token en claro solo vive ahí', async () => {
    const userId = await register();
    const correo = await lastMailTo(app, EMAIL);

    expect(correo.subject).toContain('Confirma tu correo');
    const url = urlFrom(correo, '/verificar-correo');
    // El enlace apunta a apps/web (PUBLIC_URL), nunca a esta API.
    expect(url.origin).toBe(new URL(app.config.publicUrl).origin);
    expect(url.searchParams.get('d')).toBeTruthy();
    expect(url.searchParams.get('s')).toBeTruthy();

    // En la base solo vive el HASH del token (0084): el valor en claro del
    // enlace no aparece en ninguna columna.
    const payload = JSON.parse(Buffer.from(url.searchParams.get('d')!, 'base64url').toString('utf8')) as { token: string };
    const { rows } = await db.query<{ token_hash: string; consumed_at: string | null }>(
      'select token_hash, consumed_at from email_verification_tokens where user_id = $1',
      [userId]
    );
    expect(rows.length).toBe(1);
    expect(rows[0].consumed_at).toBeNull();
    expect(rows[0].token_hash).not.toBe(payload.token);
    expect(rows[0].token_hash).not.toContain(payload.token);
  });

  it('flujo completo: login bloqueado (403) -> confirmar -> login 200, y queda auth.email_verified en audit_log', async () => {
    const userId = await register();

    const bloqueado = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } });
    expect(bloqueado.statusCode).toBe(403);
    expect(bloqueado.json().type).toContain('email-not-verified');

    const params = signedParamsFrom(await lastMailTo(app, EMAIL), '/verificar-correo');
    const verify = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: params });
    expect(verify.statusCode).toBe(200);
    expect(verify.json()).toEqual({ verified: true });

    const ok = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: EMAIL, password: PASSWORD } });
    expect(ok.statusCode).toBe(200);
    expect(typeof ok.json().accessToken).toBe('string');

    const audit = await db.query<{ actor_id: string }>(
      "select actor_id from audit_log where action = 'auth.email_verified'"
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].actor_id).toBe(userId);

    // El intento bloqueado también quedó auditado, con su motivo.
    const fallos = await db.query<{ after: { motivo?: string } }>(
      "select after from audit_log where action = 'auth.login_failed'"
    );
    expect(fallos.rows.some((r) => r.after.motivo === 'email_no_verificado')).toBe(true);
  });

  it('ADVERSARIAL: el mismo enlace NO se puede usar dos veces (token de un solo uso)', async () => {
    await register();
    const params = signedParamsFrom(await lastMailTo(app, EMAIL), '/verificar-correo');

    expect((await app.inject({ method: 'POST', url: '/auth/email/verify', payload: params })).statusCode).toBe(200);

    const segunda = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: params });
    // La FIRMA sigue siendo válida (no venció): quien rechaza es el consumo
    // atómico del token en la base -- exactamente la distinción que
    // documenta `modules/auth/mail.routes.ts`.
    expect(segunda.statusCode).toBe(400);
    expect(segunda.json().title).toMatch(/no es válido o ya venció/);
  });

  it('ADVERSARIAL: enlace con la firma o el payload manipulados -> 400 (mismo mensaje, sin distinguir el motivo)', async () => {
    await register();
    const params = signedParamsFrom(await lastMailTo(app, EMAIL), '/verificar-correo');

    const firmaCambiada = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { d: params.d, s: `${params.s.slice(0, -2)}AA` },
    });
    expect(firmaCambiada.statusCode).toBe(400);

    // Payload manipulado para apuntar a otro token, conservando la firma
    // original: la firma cubre `d` completo, así que deja de cuadrar.
    const decoded = JSON.parse(Buffer.from(params.d, 'base64url').toString('utf8')) as Record<string, unknown>;
    const manipulado = Buffer.from(JSON.stringify({ ...decoded, token: 'a'.repeat(64) }), 'utf8').toString('base64url');
    const payloadCambiado = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { d: manipulado, s: params.s } });
    expect(payloadCambiado.statusCode).toBe(400);
    expect(payloadCambiado.json().title).toBe(firmaCambiada.json().title);

    // Ninguno de los dos intentos verificó nada.
    const { rows } = await db.query<{ email_verified_at: string | null }>('select email_verified_at from users where email = $1', [EMAIL]);
    expect(rows[0].email_verified_at).toBeNull();
  });

  it('ADVERSARIAL: enlace VENCIDO (firmado correctamente) -> 400 y la cuenta sigue sin verificar', async () => {
    await register();
    const params = signedParamsFrom(await lastMailTo(app, EMAIL), '/verificar-correo');
    const decoded = JSON.parse(Buffer.from(params.d, 'base64url').toString('utf8')) as {
      verificationId: string;
      token: string;
    };

    // Mismo token real, firmado por el MISMO servicio, pero con TTL negativo:
    // aísla la expiración como única variable (la firma es válida).
    const vencido = new URL(
      app.mail.signedLink(app.config.publicUrl, '/verificar-correo', { verificationId: decoded.verificationId, token: decoded.token }, -60)
    );
    const res = await app.inject({
      method: 'POST',
      url: '/auth/email/verify',
      payload: { d: vencido.searchParams.get('d')!, s: vencido.searchParams.get('s')! },
    });
    expect(res.statusCode).toBe(400);

    const { rows } = await db.query<{ email_verified_at: string | null }>('select email_verified_at from users where email = $1', [EMAIL]);
    expect(rows[0].email_verified_at).toBeNull();
  });

  it('ADVERSARIAL: el token de una cuenta NO verifica la otra (manda el hash del token, no el id del enlace)', async () => {
    const idA = await register('token-a@example.com');
    const idB = await register('token-b@example.com');

    const paramsA = signedParamsFrom(await lastMailTo(app, 'token-a@example.com'), '/verificar-correo');
    expect((await app.inject({ method: 'POST', url: '/auth/email/verify', payload: paramsA })).statusCode).toBe(200);

    const { rows } = await db.query<{ id: string; email_verified_at: string | null }>(
      'select id, email_verified_at from users where id in ($1, $2)',
      [idA, idB]
    );
    expect(rows.find((r) => r.id === idA)!.email_verified_at).not.toBeNull();
    expect(rows.find((r) => r.id === idB)!.email_verified_at).toBeNull();
  });

  it('reenvío: responde 202 IDÉNTICO exista o no la cuenta, y solo manda correo cuando existe y falta verificar', async () => {
    await register();
    const antes = (await allMail(app)).length;

    const inexistente = await app.inject({
      method: 'POST',
      url: '/auth/email/resend-verification',
      payload: { email: 'no-existe-jamas@example.com' },
    });
    await app.waitForPendingMail();
    expect(inexistente.statusCode).toBe(202);
    expect((await allMail(app)).length).toBe(antes); // no se mandó nada

    const existente = await app.inject({ method: 'POST', url: '/auth/email/resend-verification', payload: { email: EMAIL } });
    expect(existente.statusCode).toBe(inexistente.statusCode);
    expect(existente.body).toBe(inexistente.body); // ANTI-ENUMERACIÓN: byte a byte
    expect((await allMail(app)).length).toBe(antes + 1);

    // El enlace reenviado también verifica.
    const params = signedParamsFrom(await lastMailTo(app, EMAIL), '/verificar-correo');
    expect((await app.inject({ method: 'POST', url: '/auth/email/verify', payload: params })).statusCode).toBe(200);

    // Ya verificada: un reenvío posterior responde igual pero NO manda nada.
    const total = (await allMail(app)).length;
    const yaVerificada = await app.inject({ method: 'POST', url: '/auth/email/resend-verification', payload: { email: EMAIL } });
    await app.waitForPendingMail();
    expect(yaVerificada.statusCode).toBe(202);
    expect((await allMail(app)).length).toBe(total);
  });

  it('el reenvío está acotado por el tier `auth` (5/min): el 6º intento del minuto es 429', async () => {
    const respuestas = [];
    for (let i = 0; i < 6; i++) {
      respuestas.push(
        await app.inject({ method: 'POST', url: '/auth/email/resend-verification', payload: { email: `rl-${i}@example.com` } })
      );
    }
    expect(respuestas.slice(0, 5).every((r) => r.statusCode === 202)).toBe(true);
    expect(respuestas[5].statusCode).toBe(429);
  });

  it('la compuerta es CONFIGURABLE: con requireEmailVerification=false el login sin verificar entra', async () => {
    const sinCompuerta = await createTestApp({ requireEmailVerification: false });
    try {
      const reg = await sinCompuerta.app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'sin-compuerta@example.com', password: PASSWORD },
      });
      expect(reg.statusCode).toBe(201);

      const login = await sinCompuerta.app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'sin-compuerta@example.com', password: PASSWORD },
      });
      expect(login.statusCode).toBe(200);

      // El correo de verificación SÍ se manda igual: apagar la compuerta no
      // apaga la verificación, solo deja de bloquear el acceso.
      await expect(lastMailTo(sinCompuerta.app, 'sin-compuerta@example.com')).resolves.toBeDefined();
    } finally {
      await sinCompuerta.app.close();
      await sinCompuerta.db.close();
    }
  });
});
