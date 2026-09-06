import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';
import { allMail, lastMailTo } from './helpers/mail.js';

/**
 * S7 / Ampliación 2 §2: formulario de contacto público (`POST
 * /public/contact`) -- anónimo, deja registro en `contact_requests` (0083) y
 * avisa por correo INTERNO al buzón del equipo.
 *
 * El foco de estas pruebas es el anti-abuso: un endpoint anónimo que manda
 * correo es exactamente lo que busca un spammer.
 */
describe('S7: contacto público con anti-abuso', () => {
  let app: FastifyInstance;
  let db: DbClient;

  const MENSAJE = 'Nos interesa saber si cubren licitaciones de obra pública en Nuevo León.';

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  function enviar(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/public/contact', payload, headers: { 'user-agent': 'vitest-agent/1.0' } });
  }

  it('un contacto legítimo queda registrado y dispara el correo INTERNO al buzón del equipo', async () => {
    const res = await enviar({ name: 'Ana Pérez', email: 'ana@constructora.mx', company: 'Constructora Pérez', message: MENSAJE });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });

    const { rows } = await db.query<{ name: string; email: string; company: string | null; message: string; ip: string | null; user_agent: string | null }>(
      'select name, email, company, message, ip, user_agent from contact_requests'
    );
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ name: 'Ana Pérez', email: 'ana@constructora.mx', company: 'Constructora Pérez', message: MENSAJE });
    expect(rows[0].user_agent).toBe('vitest-agent/1.0');

    // El correo va al buzón INTERNO (config.contactInbox), NUNCA a quien
    // llenó el formulario -- ese correo todavía no es una cuenta verificada
    // de nadie y responderle automáticamente sería un vector de rebote.
    const interno = await lastMailTo(app, app.config.contactInbox);
    expect(interno.to).toEqual([app.config.contactInbox]);
    expect(interno.html).toContain('ana@constructora.mx');
    const paraElContacto = (await allMail(app)).filter((c) => c.to.includes('ana@constructora.mx'));
    expect(paraElContacto).toEqual([]);
  });

  it('ANTI-ABUSO honeypot: un campo `website` lleno se descarta EN SILENCIO (mismo 202, sin registro ni correo)', async () => {
    const legitimo = await enviar({ name: 'Ana Pérez', email: 'ana@constructora.mx', message: MENSAJE });
    await app.waitForPendingMail();
    const correosTrasLegitimo = (await allMail(app)).length;

    const bot = await enviar({
      name: 'Bot Spam',
      email: 'bot@spam.example',
      message: MENSAJE,
      website: 'http://compra-seguidores.example',
    });
    await app.waitForPendingMail();

    // Indistinguible desde fuera: mismo status y mismo cuerpo.
    expect(bot.statusCode).toBe(legitimo.statusCode);
    expect(bot.body).toBe(legitimo.body);

    // Pero no dejó rastro ni gastó un correo.
    const { rows } = await db.query<{ email: string }>('select email from contact_requests');
    expect(rows.map((r) => r.email)).toEqual(['ana@constructora.mx']);
    expect((await allMail(app)).length).toBe(correosTrasLegitimo);
  });

  it('ANTI-ABUSO longitudes: mensaje demasiado corto, demasiado largo o nombre vacío -> 422 sin registro', async () => {
    expect((await enviar({ name: 'Ana Pérez', email: 'ana@x.mx', message: 'hola' })).statusCode).toBe(422);
    expect((await enviar({ name: 'A', email: 'ana@x.mx', message: MENSAJE })).statusCode).toBe(422);
    expect((await enviar({ name: 'Ana Pérez', email: 'ana@x.mx', message: 'x'.repeat(4001) })).statusCode).toBe(422);

    const { rows } = await db.query<{ id: string }>('select id from contact_requests');
    expect(rows.length).toBe(0);
  });

  it('ANTI-ABUSO límite de tasa: el 6º envío del minuto desde la misma IP es 429', async () => {
    const respuestas = [];
    for (let i = 0; i < 6; i++) {
      respuestas.push(await enviar({ name: `Persona ${i}`, email: `p${i}@example.com`, message: MENSAJE }));
    }
    expect(respuestas.slice(0, 5).every((r) => r.statusCode === 202)).toBe(true);
    expect(respuestas[5].statusCode).toBe(429);

    const { rows } = await db.query<{ id: string }>('select id from contact_requests');
    expect(rows.length).toBe(5); // el 6º nunca llegó al handler
  });
});
