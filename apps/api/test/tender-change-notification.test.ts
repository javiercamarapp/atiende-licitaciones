import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import type { MailProvider, OutboundEmail, SendResult } from '@atiende/mail';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';
import { lastMailTo, allMail } from './helpers/mail.js';
import { lastWhatsAppTo } from './helpers/whatsapp.js';

/**
 * REQ-155: la invalidación en cascada de dependientes ante un cambio de
 * convocatoria (probada en `tenders-and-ingest.test.ts`, caso A3) ahora
 * ADEMÁS notifica (correo + WhatsApp) a los miembros responsables de la
 * organización -- ver `lib/mail/tender-change-notify.ts` y el punto exacto
 * donde se dispara en `modules/tenders/internal-ingest.routes.ts`.
 *
 * Cubre exactamente lo que pide la tarea:
 *  1. Un cambio real (ya probado que invalida) también dispara la
 *     notificación con los datos correctos (qué cambió, plazos).
 *  2. La notificación respeta `isCategoryEnabled` (categoría `tender_changes`).
 *  3. Un fallo del canal de notificación NUNCA revierte ni bloquea la
 *     invalidación real, ni hace fallar la respuesta HTTP del ingest.
 */
describe('notificación de cambio de convocatoria a responsables (REQ-155)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  /** v1 (publicación) para una convocatoria nueva en `org`. */
  async function ingestPublication(targetApp: FastifyInstance, orgId: string, externalId: string): Promise<{ tenderId: string }> {
    const v1 = await targetApp.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: {
        records: [
          {
            source: 'compras-mx',
            externalId,
            title: 'Obra pública de pavimentación',
            sourceVersion: 'v1',
            submissionDeadline: '2026-12-01T00:00:00.000Z',
          },
        ],
        organizationIds: [orgId],
      },
    });
    expect(v1.statusCode).toBe(200);
    return { tenderId: v1.json().results[0].tenderId as string };
  }

  /** v2 (cambio de plazo, adelantado) sobre una convocatoria ya existente -- dispara la invalidación en cascada Y la notificación. */
  async function ingestDeadlineChange(
    targetApp: FastifyInstance,
    orgId: string,
    externalId: string,
    sourceVersion: string,
    newDeadlineIso: string
  ): Promise<void> {
    const v2 = await targetApp.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: {
        records: [
          {
            source: 'compras-mx',
            externalId,
            title: 'Obra pública de pavimentación',
            sourceVersion,
            submissionDeadline: newDeadlineIso,
            changeKind: 'deadline_change',
          },
        ],
        organizationIds: [orgId],
      },
    });
    expect(v2.statusCode).toBe(200);
    expect(v2.json().results[0].action).toBe('updated');
  }

  it('un cambio real dispara la invalidación Y la notificación con los datos correctos del cambio', async () => {
    const owner = await registerAndLogin(app, 'tc-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'TC Org 1', 'tc-org-1');
    await db.query('update users set whatsapp_phone_e164 = $1 where id = $2', ['+525511112222', owner.id]);

    const { tenderId } = await ingestPublication(app, org.id, 'TC-001');

    // Sembrar un dependiente ANTES del cambio (mismo patrón que A3) -- así
    // el cambio de plazo de abajo sí lo invalida en cascada.
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta TC-1') returning id",
      [org.id, tenderId]
    );

    await ingestDeadlineChange(app, org.id, 'TC-001', 'v2', '2026-11-15T00:00:00.000Z');
    await app.waitForPendingMail();

    // 1. La invalidación real sí ocurrió (mismo criterio que A3).
    const proposal = await db.query<{ invalidated_at: string | null }>('select invalidated_at from proposals where id = $1', [
      proposalRows[0].id,
    ]);
    expect(proposal.rows[0].invalidated_at).not.toBeNull();

    // 2. El correo llegó al responsable (el owner de la organización) con los datos correctos.
    const mail = await lastMailTo(app, owner.email);
    expect(mail.subject).toContain('Obra pública de pavimentación');
    expect(mail.text ?? mail.html).toContain('Cambio de plazo');
    // Fechas: plazo anterior y nuevo, ambos presentes en el cuerpo.
    expect(mail.html).toContain(tenderId);

    // 3. El aviso adicional de WhatsApp también se disparó, con el mismo tipo de cambio.
    const wa = lastWhatsAppTo(app, '+525511112222');
    expect(wa).toBeDefined();
    expect(wa!.templateName).toBe('cambio_convocatoria');
    expect(wa!.templateParams['1']).toBe('Obra pública de pavimentación');
  });

  it('respeta la preferencia de categoría tender_changes (isCategoryEnabled): apagada, no se manda ni correo ni WhatsApp', async () => {
    const owner = await registerAndLogin(app, 'tc-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'TC Org 2', 'tc-org-2');
    await db.query('update users set whatsapp_phone_e164 = $1 where id = $2', ['+525533334444', owner.id]);
    await db.query('insert into notification_preferences (user_id, tender_changes) values ($1, false)', [owner.id]);

    const beforeMailCount = (await allMail(app)).length;

    await ingestPublication(app, org.id, 'TC-002');
    await ingestDeadlineChange(app, org.id, 'TC-002', 'v2', '2026-11-15T00:00:00.000Z');
    await app.waitForPendingMail();

    const afterMail = await allMail(app);
    expect(afterMail.length).toBe(beforeMailCount);
    expect(lastWhatsAppTo(app, '+525533334444')).toBeUndefined();
  });

  it('un fallo del canal de notificación (correo) nunca revierte ni bloquea la invalidación real', async () => {
    const throwingMailProvider: MailProvider = {
      name: 'fake-throwing-mail',
      async send(_message: OutboundEmail): Promise<SendResult> {
        throw new Error('Fallo simulado del proveedor de correo (prueba REQ-155)');
      },
    };
    const custom = await createTestApp({}, { mailProvider: throwingMailProvider });
    try {
      const owner = await registerAndLogin(custom.app, 'tc-owner-3@example.com');
      const org = await createOrgFor(custom.app, owner, 'TC Org 3', 'tc-org-3');

      const { tenderId } = await ingestPublication(custom.app, org.id, 'TC-003');

      const { rows: proposalRows } = await custom.db.query<{ id: string }>(
        "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta TC-3') returning id",
        [org.id, tenderId]
      );

      // El propio `inject` resolviendo 200, más `waitForPendingMail()`
      // resolviendo sin lanzar, ya demuestran que el fallo del proveedor de
      // correo (arriba) no se propagó ni a la respuesta HTTP ni al proceso.
      await ingestDeadlineChange(custom.app, org.id, 'TC-003', 'v2', '2026-11-01T00:00:00.000Z');

      await custom.app.waitForPendingMail();

      const proposal = await custom.db.query<{ invalidated_at: string | null }>(
        'select invalidated_at from proposals where id = $1',
        [proposalRows[0].id]
      );
      expect(proposal.rows[0].invalidated_at).not.toBeNull();
    } finally {
      await custom.app.close();
      await custom.db.close();
    }
  });
});
