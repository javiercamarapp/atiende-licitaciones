import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { formatFechaEs } from '@atiende/mail';
import type { OutboundWhatsAppMessage, SendResult, WhatsAppProvider } from '@atiende/whatsapp';
import { createTestApp } from './helpers.js';
import { lastMailTo } from './helpers/mail.js';
import { allWhatsAppMessages, lastWhatsAppTo } from './helpers/whatsapp.js';
import { sendNewTenderMatchEmail, sendSubmissionPackageReadyEmail } from '../src/lib/mail/triggers.js';

/**
 * Canal ADICIONAL de WhatsApp (`lib/mail/whatsapp-channel.ts`) para
 * `tender_matches` (`sendNewTenderMatchEmail`) y `submission`
 * (`sendSubmissionPackageReadyEmail`) -- ver el comentario de esos trigger
 * functions (`triggers.ts`) y `packages/whatsapp/README.md`.
 *
 * Cubre exactamente lo que pide la tarea:
 *  1. Se dispara cuando la categoría está activa y hay teléfono guardado.
 *  2. NO se dispara si la categoría está apagada (misma preferencia que el correo).
 *  3. NO se dispara si no hay teléfono guardado.
 *  4. Un fallo de WhatsApp (`not_configured` o cualquier otro, incluida una
 *     excepción del proveedor) nunca impide ni revierte el correo, y nunca
 *     hace fallar la operación de negocio que lo originó.
 */
describe('canal adicional de WhatsApp (tender_matches / submission)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  /**
   * Guarda el número en `users.whatsapp_phone_e164` (0090) Y lo devuelve
   * como `whatsappPhone` -- exactamente el mismo camino que seguiría un
   * caller real: cargar la fila de `users` (con su columna de teléfono, si
   * la tiene) y pasarla al trigger function como `MinimalUserWithPhone`
   * (`triggers.ts` nunca hace su propia consulta a `users`, ver el
   * comentario de esa interfaz).
   */
  async function seedOrgAndUser(
    slug: string,
    opts: { phone?: string | null } = {}
  ): Promise<{ orgId: string; userId: string; email: string; whatsappPhone: string | null }> {
    const { rows } = await db.query<{ id: string }>(
      'insert into organizations (name, slug) values ($1, $1) returning id',
      [slug]
    );
    const orgId = rows[0].id;
    const email = `${slug}@example.com`;
    const whatsappPhone = opts.phone ?? null;
    const { rows: userRows } = await db.query<{ id: string }>(
      "insert into users (id, email, password_hash, whatsapp_phone_e164) values (gen_random_uuid(), $1, 'x', $2) returning id",
      [email, whatsappPhone]
    );
    const userId = userRows[0].id;
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [orgId, userId]);
    return { orgId, userId, email, whatsappPhone };
  }

  const NEW_MATCH_PARAMS = {
    tenderId: 'tender-e2e-1',
    tenderTitle: 'Suministro de uniformes escolares',
    contractingEntity: 'Secretaría de Ejemplo del Estado',
    matchScore: 92,
    estimatedValue: '$4,850,000.00 MXN',
    submissionDeadlineIso: '2026-10-02T18:00:00.000Z',
    tenderUrl: 'https://app.atiende.mx/convocatorias/demo-001',
  };

  const SUBMISSION_PARAMS = {
    tenderId: 'tender-e2e-2',
    tenderTitle: 'Mantenimiento de flotilla vehicular',
    documentCount: 12,
    submissionDeadlineIso: '2026-10-07T18:00:00.000Z',
    packageUrl: 'https://app.atiende.mx/expedientes/demo-002/paquete',
  };

  it('se dispara cuando tender_matches está activa (default) y hay teléfono guardado', async () => {
    const { orgId, userId, email, whatsappPhone } = await seedOrgAndUser('wa-match-ok', { phone: '+525512345678' });

    const outcome = await sendNewTenderMatchEmail(app, { id: userId, email, whatsappPhone }, { organizationId: orgId, ...NEW_MATCH_PARAMS });

    expect(outcome.status).toBe('sent');
    // El correo (canal principal) sí se mandó -- WhatsApp es adicional, nunca en su lugar.
    const mail = await lastMailTo(app, email);
    expect(mail.subject).toContain(NEW_MATCH_PARAMS.tenderTitle);

    const wa = lastWhatsAppTo(app, '+525512345678');
    expect(wa).toBeDefined();
    expect(wa!.templateName).toBe('nuevo_match_licitacion');
    expect(wa!.templateParams).toEqual({
      '1': NEW_MATCH_PARAMS.tenderTitle,
      '2': formatFechaEs(NEW_MATCH_PARAMS.submissionDeadlineIso),
    });
  });

  it('se dispara para submission cuando la categoría está activa y hay teléfono guardado', async () => {
    const { orgId, userId, email, whatsappPhone } = await seedOrgAndUser('wa-submission-ok', { phone: '+525587654321' });

    const outcome = await sendSubmissionPackageReadyEmail(app, { id: userId, email, whatsappPhone }, { organizationId: orgId, ...SUBMISSION_PARAMS });

    expect(outcome.status).toBe('sent');
    await lastMailTo(app, email);

    const wa = lastWhatsAppTo(app, '+525587654321');
    expect(wa).toBeDefined();
    expect(wa!.templateName).toBe('paquete_listo_licitacion');
    expect(wa!.templateParams).toEqual({
      '1': SUBMISSION_PARAMS.tenderTitle,
      '2': String(SUBMISSION_PARAMS.documentCount),
      '3': formatFechaEs(SUBMISSION_PARAMS.submissionDeadlineIso),
    });
  });

  it('NO se dispara si la categoría tender_matches está apagada, aunque haya teléfono guardado', async () => {
    const { orgId, userId, email, whatsappPhone } = await seedOrgAndUser('wa-match-off', { phone: '+525500000001' });
    await db.query('insert into notification_preferences (user_id, tender_matches) values ($1, false)', [userId]);

    const before = allWhatsAppMessages(app).length;
    const outcome = await sendNewTenderMatchEmail(app, { id: userId, email, whatsappPhone }, { organizationId: orgId, ...NEW_MATCH_PARAMS });

    // Misma preferencia que ya controla el correo -- apagada, apaga los dos canales.
    expect(outcome.status).toBe('skipped_preferences');
    expect(allWhatsAppMessages(app).length).toBe(before);
    expect(lastWhatsAppTo(app, '+525500000001')).toBeUndefined();
  });

  it('NO se dispara si la categoría submission está apagada, aunque haya teléfono guardado', async () => {
    const { orgId, userId, email, whatsappPhone } = await seedOrgAndUser('wa-submission-off', { phone: '+525500000002' });
    await db.query('insert into notification_preferences (user_id, submission) values ($1, false)', [userId]);

    const outcome = await sendSubmissionPackageReadyEmail(app, { id: userId, email, whatsappPhone }, { organizationId: orgId, ...SUBMISSION_PARAMS });

    expect(outcome.status).toBe('skipped_preferences');
    expect(lastWhatsAppTo(app, '+525500000002')).toBeUndefined();
  });

  it('NO se dispara si el usuario no tiene ningún número de WhatsApp guardado', async () => {
    const { orgId, userId, email, whatsappPhone } = await seedOrgAndUser('wa-sin-numero'); // sin `phone` -> whatsapp_phone_e164 queda null
    expect(whatsappPhone).toBeNull();

    const before = allWhatsAppMessages(app).length;
    const outcome = await sendNewTenderMatchEmail(app, { id: userId, email, whatsappPhone }, { organizationId: orgId, ...NEW_MATCH_PARAMS });

    // El correo (canal principal) se manda con total normalidad.
    expect(outcome.status).toBe('sent');
    await lastMailTo(app, email);
    // Nada nuevo se agregó al canal de WhatsApp -- no hay a quién mandarle.
    expect(allWhatsAppMessages(app).length).toBe(before);
  });

  it('un fallo declarado de WhatsApp (not_configured) nunca impide ni revierte el correo ya enviado', async () => {
    const notConfiguredProvider: WhatsAppProvider = {
      name: 'fake-not-configured',
      async send(): Promise<SendResult> {
        return { ok: false, kind: 'not_configured' };
      },
      async sendInteractiveList(): Promise<SendResult> {
        return { ok: false, kind: 'not_configured' };
      },
      async sendText(): Promise<SendResult> {
        return { ok: false, kind: 'not_configured' };
      },
    };
    const custom = await createTestApp({}, { whatsappProvider: notConfiguredProvider });
    try {
      const { orgId, userId, email, whatsappPhone } = await seedOrgAndUserOn(custom.db, 'wa-not-configured', '+525500000003');

      const outcome = await sendNewTenderMatchEmail(custom.app, { id: userId, email, whatsappPhone }, { organizationId: orgId, ...NEW_MATCH_PARAMS });

      // El correo tuvo éxito -- el estado declarado de WhatsApp no lo toca.
      expect(outcome.status).toBe('sent');
      const mail = await lastMailTo(custom.app, email);
      expect(mail.subject).toContain(NEW_MATCH_PARAMS.tenderTitle);
    } finally {
      await custom.app.close();
      await custom.db.close();
    }
  });

  it('una excepción inesperada del proveedor de WhatsApp nunca hace fallar el envío del correo ni la llamada del trigger', async () => {
    const throwingProvider: WhatsAppProvider = {
      name: 'fake-throwing',
      async send(_message: OutboundWhatsAppMessage): Promise<SendResult> {
        throw new Error('Fallo simulado del proveedor de WhatsApp (prueba)');
      },
      async sendInteractiveList(): Promise<SendResult> {
        throw new Error('Fallo simulado del proveedor de WhatsApp (prueba)');
      },
      async sendText(): Promise<SendResult> {
        throw new Error('Fallo simulado del proveedor de WhatsApp (prueba)');
      },
    };
    const custom = await createTestApp({}, { whatsappProvider: throwingProvider });
    try {
      const { orgId, userId, email, whatsappPhone } = await seedOrgAndUserOn(custom.db, 'wa-throws', '+525500000004');

      // Si el fallo de WhatsApp se propagara, este `await` rechazaría --
      // la propia aserción de que resuelve (y no lanza) es la prueba.
      const outcome = await sendNewTenderMatchEmail(custom.app, { id: userId, email, whatsappPhone }, { organizationId: orgId, ...NEW_MATCH_PARAMS });

      expect(outcome.status).toBe('sent');
      await lastMailTo(custom.app, email);
    } finally {
      await custom.app.close();
      await custom.db.close();
    }
  });

  async function seedOrgAndUserOn(
    targetDb: DbClient,
    slug: string,
    phone: string
  ): Promise<{ orgId: string; userId: string; email: string; whatsappPhone: string }> {
    const { rows } = await targetDb.query<{ id: string }>(
      'insert into organizations (name, slug) values ($1, $1) returning id',
      [slug]
    );
    const orgId = rows[0].id;
    const email = `${slug}@example.com`;
    const { rows: userRows } = await targetDb.query<{ id: string }>(
      "insert into users (id, email, password_hash, whatsapp_phone_e164) values (gen_random_uuid(), $1, 'x', $2) returning id",
      [email, phone]
    );
    const userId = userRows[0].id;
    await targetDb.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [orgId, userId]);
    return { orgId, userId, email, whatsappPhone: phone };
  }
});
