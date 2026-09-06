import { createHmac, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin } from './helpers.js';
import { allMail } from './helpers/mail.js';
import { sendTransactionalMail } from '../src/lib/mail/send-transactional.js';
import { registeredUserRecipient } from '../src/lib/mail/recipients.js';

/**
 * REQ-181..195 (docs/AMPLIACION-2-SALIDA.md §2): webhook de entrega/rebote
 * del proveedor (`POST /webhooks/mail/resend`), con verificación de firma
 * Svix y guardia de replay (ML-05) -> lista de supresión.
 *
 * Todo lo de aquí entra sin autenticar desde Internet: cada caso adversarial
 * comprueba no solo el status, sino que NO haya efecto de negocio.
 */
const WEBHOOK_SECRET = `whsec_${Buffer.from('secreto-de-webhook-de-prueba-0123456789').toString('base64')}`;

describe('REQ-181..195: webhook de correo (firma Svix + anti-replay -> supresión)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp({ mailWebhookSecret: WEBHOOK_SECRET }));
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  /** Firma un cuerpo tal como lo haría Svix/Resend: base64(HMAC-SHA256(`${id}.${ts}.${body}`)). */
  function firmar(rawBody: string, options: { svixId?: string; timestampSeconds?: number; secret?: string } = {}) {
    const svixId = options.svixId ?? `msg_${randomUUID()}`;
    const svixTimestamp = String(options.timestampSeconds ?? Math.floor(Date.now() / 1000));
    const secreto = options.secret ?? WEBHOOK_SECRET;
    const bytes = Buffer.from(secreto.replace(/^whsec_/, ''), 'base64');
    const firma = createHmac('sha256', bytes).update(`${svixId}.${svixTimestamp}.${rawBody}`).digest('base64');
    return {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': `v1,${firma}`,
    };
  }

  function cuerpo(type: string, email: string): string {
    return JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: 'em_123', to: [email] } });
  }

  function entregar(rawBody: string, headers: Record<string, string>) {
    return app.inject({ method: 'POST', url: '/webhooks/mail/resend', headers, payload: rawBody });
  }

  async function suprimidas(): Promise<{ email: string; reason: string; source: string }[]> {
    const { rows } = await db.query<{ email: string; reason: string; source: string }>(
      'select email, reason, source from mail_suppressions'
    );
    return rows;
  }

  it('un rebote con firma válida suprime la dirección, y el siguiente envío a esa dirección se descarta', async () => {
    const usuario = await registerAndLogin(app, 'rebota@example.com');
    const raw = cuerpo('email.bounced', 'rebota@example.com');

    const res = await entregar(raw, firmar(raw));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ processed: true, type: 'email.bounced' });
    expect(await suprimidas()).toEqual([{ email: 'rebota@example.com', reason: 'bounce', source: 'webhook:resend' }]);

    const antes = (await allMail(app)).length;
    const salida = await sendTransactionalMail(app, {
      to: registeredUserRecipient({ id: usuario.id, email: 'rebota@example.com' }),
      templateId: 'email-verification',
      messageKey: `email-verification:${randomUUID()}`,
      variables: {
        recipientName: 'Rebota',
        appUrl: app.config.publicUrl,
        supportEmail: app.config.supportEmail,
        verificationUrl: `${app.config.publicUrl}/verificar-correo?d=x&s=y`,
        expiresInMinutes: 30,
      },
    });
    // Ni siquiera una plantilla OBLIGATORIA se manda a una dirección
    // suprimida: la supresión es del canal, no de la categoría.
    expect(salida.status).toBe('skipped_suppressed');
    expect((await allMail(app)).length).toBe(antes);
  });

  it('una queja de spam suprime con motivo `complaint`', async () => {
    const raw = cuerpo('email.complained', 'queja@example.com');
    expect((await entregar(raw, firmar(raw))).statusCode).toBe(202);
    expect(await suprimidas()).toEqual([{ email: 'queja@example.com', reason: 'complaint', source: 'webhook:resend' }]);
  });

  it('ADVERSARIAL: webhook FORJADO (firma con otro secreto) -> 401 y NINGÚN efecto', async () => {
    const raw = cuerpo('email.bounced', 'forjado@example.com');
    const headers = firmar(raw, { secret: `whsec_${Buffer.from('secreto-del-atacante-0123456789').toString('base64')}` });

    const res = await entregar(raw, headers);
    expect(res.statusCode).toBe(401);
    expect(await suprimidas()).toEqual([]);
  });

  it('ADVERSARIAL: cuerpo alterado DESPUÉS de firmar -> 401 y ningún efecto', async () => {
    const raw = cuerpo('email.bounced', 'original@example.com');
    const headers = firmar(raw);
    const alterado = cuerpo('email.bounced', 'victima@example.com');

    expect((await entregar(alterado, headers)).statusCode).toBe(401);
    expect(await suprimidas()).toEqual([]);
  });

  it('ADVERSARIAL: cabeceras Svix ausentes o timestamp fuera de la ventana -> 401', async () => {
    const raw = cuerpo('email.bounced', 'sin-cabeceras@example.com');

    expect((await entregar(raw, { 'content-type': 'application/json' })).statusCode).toBe(401);

    const viejo = firmar(raw, { timestampSeconds: Math.floor(Date.now() / 1000) - 3600 });
    expect((await entregar(raw, viejo)).statusCode).toBe(401);
    expect(await suprimidas()).toEqual([]);
  });

  it('ADVERSARIAL (ML-05): REENVIAR la misma petición firmada -> 409 y no se reaplica el efecto', async () => {
    const raw = cuerpo('email.bounced', 'replay@example.com');
    const headers = firmar(raw);

    expect((await entregar(raw, headers)).statusCode).toBe(202);
    expect(await suprimidas()).toHaveLength(1);

    // Se deshace el efecto a mano para que el replay tenga algo que
    // "reaplicar": si lo lograra, la fila volvería a aparecer.
    await db.query('delete from mail_suppressions');

    const replay = await entregar(raw, headers);
    expect(replay.statusCode).toBe(409);
    expect(await suprimidas()).toEqual([]);

    // Un evento NUEVO (otro svix-id) con el mismo cuerpo sí pasa: el guardia
    // deduplica por `svix-id`, no censura la dirección para siempre.
    expect((await entregar(raw, firmar(raw))).statusCode).toBe(202);
    expect(await suprimidas()).toHaveLength(1);
  });

  it('un evento con firma válida pero de un tipo que no modelamos se acepta y se ignora', async () => {
    const raw = cuerpo('email.opened', 'abierto@example.com');
    const res = await entregar(raw, firmar(raw));
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ processed: false, type: null });
    expect(await suprimidas()).toEqual([]);
  });

  it('SIN secreto configurado el endpoint responde 503 y NUNCA procesa nada (falla cerrado)', async () => {
    const sinSecreto = await createTestApp({ mailWebhookSecret: undefined });
    try {
      const raw = cuerpo('email.bounced', 'sin-secreto@example.com');
      const res = await sinSecreto.app.inject({ method: 'POST', url: '/webhooks/mail/resend', headers: firmar(raw), payload: raw });
      expect(res.statusCode).toBe(503);

      const { rows } = await sinSecreto.db.query('select email from mail_suppressions');
      expect(rows.length).toBe(0);
    } finally {
      await sinSecreto.app.close();
      await sinSecreto.db.close();
    }
  });

  it('un proveedor desconocido en la ruta se rechaza por esquema (lista cerrada)', async () => {
    const raw = cuerpo('email.bounced', 'otro@example.com');
    const res = await app.inject({ method: 'POST', url: '/webhooks/mail/mailchimp', headers: firmar(raw), payload: raw });
    expect(res.statusCode).toBe(422);
  });
});
