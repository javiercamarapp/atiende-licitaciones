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

  /** `emailId: null` (nunca `undefined`, que en JS dispara el default del parámetro) omite `data.email_id` del payload. */
  function cuerpo(type: string, email: string, emailId: string | null = 'em_123'): string {
    const data: Record<string, unknown> = { to: [email] };
    if (emailId !== null) data.email_id = emailId;
    return JSON.stringify({ type, created_at: new Date().toISOString(), data });
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

  /**
   * AM-03: fila REAL de `mail_outbox` -- así un evento de webhook que
   * referencia este `providerMessageId` corresponde a un envío verdadero de
   * este entorno (ver `apps/api/src/lib/mail/pg-outbox-lookup.ts`). Escrito
   * con `db.query` directo (sin `set local role app_role`), mismo criterio
   * que `test/helpers.ts#registerAndLogin` para sembrar estado fuera de
   * cualquier sesión real.
   */
  async function seedOutbox(providerMessageId: string, toEmail: string, status: 'sent' | 'failed_permanent' | 'dead' = 'sent'): Promise<void> {
    await db.query(
      `insert into mail_outbox (dedupe_key, template_id, status, provider_message_id, to_email)
       values ($1, 'test-template', $2, $3, $4)`,
      [`test:${providerMessageId}:${toEmail}`, status, providerMessageId, toEmail]
    );
  }

  async function eventosIgnorados(): Promise<{ action: string; after: { reason?: string; email?: string; type?: string } }[]> {
    const { rows } = await db.query<{ action: string; after: { reason?: string; email?: string; type?: string } }>(
      "select action, after from audit_log where entity = 'mail_webhook'"
    );
    return rows;
  }

  it('un rebote con firma válida suprime la dirección, y el siguiente envío a esa dirección se descarta', async () => {
    const usuario = await registerAndLogin(app, 'rebota@example.com');
    // AM-03: la supresión ahora exige que `em_123` corresponda a un envío
    // REAL a esta dirección en `mail_outbox` -- este test representa el caso
    // LEGÍTIMO (un correo que sí mandamos, que sí rebotó).
    await seedOutbox('em_123', 'rebota@example.com');
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

  it('una queja de spam suprime con motivo `complaint` cuando corresponde a un envío real', async () => {
    // AM-03 (docs/auditoria-2/api-mail.md): este era EXACTAMENTE el test que
    // demostraba el hallazgo -- `queja@example.com` nunca había recibido
    // nada nuestro y aun así quedaba suprimida. Ahora requiere una fila real
    // en `mail_outbox`; el caso SIN ella se cubre en el bloque "AM-03" de
    // abajo.
    await seedOutbox('em_123', 'queja@example.com');
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
    await seedOutbox('em_123', 'replay@example.com');
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

  /**
   * AM-03 (docs/auditoria-2/api-mail.md, ALTA): la firma Svix prueba que el
   * payload lo mandó Resend -- NUNCA que el `email_id`/destinatario que trae
   * dentro corresponda a un envío real de este entorno. Antes de este fix,
   * `applyMailWebhookEvent` suprimía cualquier dirección con firma válida
   * sin cruzar `mail_outbox`; el propio caso "una queja de spam suprime..."
   * de arriba lo demostraba (ver el commit que introduce este bloque).
   */
  describe('AM-03: la supresión exige que el evento corresponda a un envío real de mail_outbox', () => {
    it('un rebote con `email_id` que NUNCA existió en `mail_outbox` NO suprime, y queda un evento ignorado en audit_log', async () => {
      const usuario = await registerAndLogin(app, 'victima-am03@example.com');
      const raw = cuerpo('email.bounced', 'victima-am03@example.com', 'em_nunca_existio');

      const res = await entregar(raw, firmar(raw));
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ processed: false, type: 'email.bounced' });
      expect(await suprimidas()).toEqual([]);

      const ignorados = await eventosIgnorados();
      expect(ignorados).toHaveLength(1);
      expect(ignorados[0].after).toMatchObject({ reason: 'sin_envio_correspondiente', email: 'victima-am03@example.com', type: 'email.bounced' });

      // La garantía completa (REQ-187, "las transaccionales críticas de
      // seguridad se envían siempre"): tras el bounce forjado, un
      // restablecimiento de contraseña REAL para esta cuenta sigue
      // generando una fila en `mail_outbox` -- antes de este fix, la
      // supresión indebida lo habría descartado en silencio (el hallazgo
      // exacto que documentó la auditoría en vivo).
      const forgot = await app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'victima-am03@example.com' } });
      expect(forgot.statusCode).toBe(202);
      await allMail(app);
      const { rows } = await db.query<{ to_email: string }>(
        "select to_email from mail_outbox where template_id = 'password-reset' and to_email = $1",
        ['victima-am03@example.com']
      );
      expect(rows).toHaveLength(1);
      void usuario;
    });

    it('un rebote sin `email_id` (payload incompleto) NO suprime, y queda un evento ignorado en audit_log', async () => {
      const raw = cuerpo('email.bounced', 'sin-email-id@example.com', null);
      const res = await entregar(raw, firmar(raw));
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ processed: false, type: 'email.bounced' });
      expect(await suprimidas()).toEqual([]);

      const ignorados = await eventosIgnorados();
      expect(ignorados).toHaveLength(1);
      expect(ignorados[0].after).toMatchObject({ reason: 'sin_provider_message_id' });
    });

    it('un `email_id` real de un envío a OTRO destinatario no suprime la dirección del evento (no basta con que la fila exista)', async () => {
      await seedOutbox('em_para_otro', 'legitimo@example.com');
      const raw = cuerpo('email.bounced', 'victima-cruzada@example.com', 'em_para_otro');

      const res = await entregar(raw, firmar(raw));
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ processed: false, type: 'email.bounced' });
      expect(await suprimidas()).toEqual([]);
    });
  });
});
