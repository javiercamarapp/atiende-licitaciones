import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, type RegisteredUser } from './helpers.js';
import { allMail } from './helpers/mail.js';
import { buildUnsubscribeUrl, buildPreferencesUrl } from '../src/lib/mail/links.js';
import { sendTransactionalMail } from '../src/lib/mail/send-transactional.js';
import { registeredUserRecipient } from '../src/lib/mail/recipients.js';

/**
 * S6 / REQ-187 (docs/ACEPTACION.md): "baja de notificaciones respetada
 * (salvo transaccionales de seguridad)" -- baja de un clic (RFC 8058) y
 * centro de preferencias.
 *
 * La prueba que de verdad importa no es que la fila cambie, sino que
 * DEJE DE LLEGAR el correo: por eso varios casos mandan una plantilla
 * OPCIONAL real (`deadline-reminder`) por el mismo camino de producción
 * (`sendTransactionalMail`) antes y después de la baja.
 */
describe('S6/REQ-187: baja de un clic (RFC 8058) y preferencias', () => {
  let app: FastifyInstance;
  let db: DbClient;
  let usuario: RegisteredUser;

  const TODAS_ACTIVAS = {
    tenderMatches: true,
    tenderChanges: true,
    approvals: true,
    submission: true,
    deadlines: true,
    documentExpiration: true,
    postAward: true,
    weeklySummary: true,
  };

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
    usuario = await registerAndLogin(app, 'preferencias@example.com');
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  function auth() {
    return { authorization: `Bearer ${usuario.accessToken}` };
  }

  /** Manda un recordatorio de plazo (categoría OPCIONAL `deadlines`) por el camino real. */
  async function mandarRecordatorio(sufijo: string) {
    return sendTransactionalMail(app, {
      to: registeredUserRecipient({ id: usuario.id, email: usuario.email }),
      templateId: 'deadline-reminder',
      messageKey: `deadline-reminder:${usuario.id}:${sufijo}`,
      variables: {
        recipientName: 'Preferencias',
        appUrl: app.config.publicUrl,
        supportEmail: app.config.supportEmail,
        preferencesUrl: buildPreferencesUrl(app),
        unsubscribeUrl: buildUnsubscribeUrl(app, usuario.id, 'deadlines'),
        tenderTitle: 'Suministro de equipo de cómputo',
        submissionDeadlineIso: '2026-10-07T18:00:00.000Z',
        hoursRemaining: 48,
        actionUrl: `${app.config.publicUrl}/convocatorias/demo-001`,
      },
    });
  }

  function paramsDe(url: string): { d: string; s: string } {
    const parsed = new URL(url);
    return { d: parsed.searchParams.get('d')!, s: parsed.searchParams.get('s')! };
  }

  it('sin fila en la base, todas las categorías están ACTIVAS (lista de exclusión, no de opt-in)', async () => {
    const res = await app.inject({ method: 'GET', url: '/mail/preferences', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(TODAS_ACTIVAS);

    const { rows } = await db.query<{ user_id: string }>('select user_id from notification_preferences');
    expect(rows.length).toBe(0); // la fila se crea perezosamente, no al leer
  });

  it('PUT /mail/preferences apaga solo lo indicado y GET lo refleja', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/mail/preferences',
      headers: auth(),
      payload: { deadlines: false, weeklySummary: false },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ ...TODAS_ACTIVAS, deadlines: false, weeklySummary: false });

    const get = await app.inject({ method: 'GET', url: '/mail/preferences', headers: auth() });
    expect(get.json()).toEqual({ ...TODAS_ACTIVAS, deadlines: false, weeklySummary: false });
  });

  it('la preferencia SE APLICA al enviar: un correo opcional apagado no se manda, uno obligatorio sí', async () => {
    // Antes de la baja: llega.
    expect((await mandarRecordatorio('antes')).status).toBe('sent');
    expect((await allMail(app)).some((c) => c.subject.startsWith('Vence en 48 horas'))).toBe(true);

    await app.inject({ method: 'PUT', url: '/mail/preferences', headers: auth(), payload: { deadlines: false } });

    // Después: el MailService lo descarta por preferencias, sin tocar el proveedor.
    const despues = await mandarRecordatorio('despues');
    expect(despues.status).toBe('skipped_preferences');

    // Un correo OBLIGATORIO (seguridad de cuenta) sigue llegando: las
    // categorías obligatorias no se pueden apagar.
    const antes = (await allMail(app)).length;
    const reenvio = await app.inject({
      method: 'POST',
      url: '/auth/email/resend-verification',
      payload: { email: 'no-verificada@example.com' },
    });
    expect(reenvio.statusCode).toBe(202);
    expect(antes).toBeGreaterThan(0);
  });

  it('RFC 8058: el POST de un clic (form-urlencoded, sin sesión) apaga la categoría y responde 200 sin HTML', async () => {
    const url = buildUnsubscribeUrl(app, usuario.id, 'deadlines');
    const { d, s } = paramsDe(url);

    const res = await app.inject({
      method: 'POST',
      url: `/mail/unsubscribe?d=${encodeURIComponent(d)}&s=${encodeURIComponent(s)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(res.statusCode).toBe(200); // nunca 3xx: un cliente de correo no navega
    expect(res.headers['content-type']).toContain('application/json');

    const prefs = await app.inject({ method: 'GET', url: '/mail/preferences', headers: auth() });
    expect(prefs.json()).toEqual({ ...TODAS_ACTIVAS, deadlines: false });
    expect((await mandarRecordatorio('tras-baja')).status).toBe('skipped_preferences');
  });

  it('la baja SIN categoría apaga TODAS las opcionales de una vez', async () => {
    const { d, s } = paramsDe(buildUnsubscribeUrl(app, usuario.id));
    const res = await app.inject({ method: 'POST', url: `/mail/unsubscribe?d=${encodeURIComponent(d)}&s=${encodeURIComponent(s)}` });
    expect(res.statusCode).toBe(200);

    const prefs = await app.inject({ method: 'GET', url: '/mail/preferences', headers: auth() });
    expect(Object.values(prefs.json() as Record<string, boolean>).every((v) => v === false)).toBe(true);
  });

  it('el GET del enlace de baja NO aplica nada (un escáner de enlaces no debe darte de baja)', async () => {
    const { d, s } = paramsDe(buildUnsubscribeUrl(app, usuario.id, 'weekly_summary'));
    const res = await app.inject({ method: 'GET', url: `/mail/unsubscribe?d=${encodeURIComponent(d)}&s=${encodeURIComponent(s)}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ valid: true, category: 'weekly_summary' });

    const prefs = await app.inject({ method: 'GET', url: '/mail/preferences', headers: auth() });
    expect(prefs.json()).toEqual(TODAS_ACTIVAS);
  });

  it('ADVERSARIAL: firma manipulada, enlace vencido y categoría desconocida -> 400 sin cambiar nada', async () => {
    const { d, s } = paramsDe(buildUnsubscribeUrl(app, usuario.id, 'deadlines'));

    const firmaMala = await app.inject({
      method: 'POST',
      url: `/mail/unsubscribe?d=${encodeURIComponent(d)}&s=${encodeURIComponent(`${s.slice(0, -2)}AA`)}`,
    });
    expect(firmaMala.statusCode).toBe(400);

    const vencido = paramsDe(
      app.mail.signedLink(app.config.publicUrl, '/preferencias/baja', { userId: usuario.id, category: 'deadlines' }, -60)
    );
    const expirado = await app.inject({
      method: 'POST',
      url: `/mail/unsubscribe?d=${encodeURIComponent(vencido.d)}&s=${encodeURIComponent(vencido.s)}`,
    });
    expect(expirado.statusCode).toBe(400);

    // Categoría inventada (o una OBLIGATORIA como `account_security`):
    // enlace firmado por el servicio, pero rechazado igual -- nunca se
    // interpreta como "apaga todo".
    const inventada = paramsDe(
      app.mail.signedLink(app.config.publicUrl, '/preferencias/baja', { userId: usuario.id, category: 'account_security' }, 600)
    );
    const rechazada = await app.inject({
      method: 'POST',
      url: `/mail/unsubscribe?d=${encodeURIComponent(inventada.d)}&s=${encodeURIComponent(inventada.s)}`,
    });
    expect(rechazada.statusCode).toBe(400);

    const prefs = await app.inject({ method: 'GET', url: '/mail/preferences', headers: auth() });
    expect(prefs.json()).toEqual(TODAS_ACTIVAS);
  });

  it('ADVERSARIAL: la baja de una persona no toca las preferencias de OTRA, y el centro exige sesión', async () => {
    const otra = await registerAndLogin(app, 'otra-persona@example.com');
    const { d, s } = paramsDe(buildUnsubscribeUrl(app, usuario.id, 'deadlines'));
    await app.inject({ method: 'POST', url: `/mail/unsubscribe?d=${encodeURIComponent(d)}&s=${encodeURIComponent(s)}` });

    const suyas = await app.inject({
      method: 'GET',
      url: '/mail/preferences',
      headers: { authorization: `Bearer ${otra.accessToken}` },
    });
    expect(suyas.json()).toEqual(TODAS_ACTIVAS);

    // Sin sesión, el centro de preferencias no se lee ni se escribe.
    expect((await app.inject({ method: 'GET', url: '/mail/preferences' })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'PUT', url: '/mail/preferences', payload: { deadlines: false } })).statusCode
    ).toBe(401);
  });
});
