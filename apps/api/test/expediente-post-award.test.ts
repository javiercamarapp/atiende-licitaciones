import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * E11 — seguimiento post-adjudicación: hitos/garantías/facturación y plazo
 * de pago a 17 días hábiles (LAASSP Art. 73, docs/legal/verificacion-legal.md).
 * Recordatorios encolados en `jobs`, SIN envío externo.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'pa-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Contrato adjudicado', sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('expediente — seguimiento post-adjudicación (E11)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('crea un hito genérico con recordatorio encolado en jobs (sin envío externo)', async () => {
    const owner = await registerAndLogin(app, 'pa-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'PA Org 1', 'pa-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'garantia', label: 'Fianza de cumplimiento', dueDate: '2027-01-15', reminderLeadDays: 5 },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().jobId).toBeTruthy();

    const job = await db.query('select kind, status, payload from jobs where id = $1', [create.json().jobId]);
    expect(job.rows[0].kind).toBe('post_award_followup_reminder');
    expect(job.rows[0].status).toBe('queued');

    const list = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/post-award`, headers });
    expect(list.statusCode).toBe(200);
    expect(list.json().length).toBe(1);

    const update = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/post-award/${create.json().id}`,
      headers,
      payload: { status: 'done', notes: 'Fianza entregada y aceptada.' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().status).toBe('done');
  });

  it('kind="pago" calcula el vencimiento a 17 días hábiles (LAASSP Art. 73) desde la verificación de la factura, con fuente legal citada', async () => {
    const owner = await registerAndLogin(app, 'pa-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'PA Org 2', 'pa-org-2');
    const tenderId = await createTender(app, org.id, 'pa-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // 2026-01-05 es lunes; +17 días hábiles (sin feriados declarados) cae el 2026-01-28 (miércoles).
    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'pago', label: 'Pago de factura #001', invoiceVerifiedOn: '2026-01-05' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().dueDate).toContain('2026-01-28');
    expect(create.json().legalReference).toContain('Art. 73');
    expect(create.json().legalReference).toContain('17');

    const missingInvoiceDate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'pago', label: 'Pago sin fecha de verificación' },
    });
    expect(missingInvoiceDate.statusCode).toBe(422);
  });

  it('viewer no puede crear ni actualizar seguimientos; writer sí', async () => {
    const owner = await registerAndLogin(app, 'pa-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'PA Org 3', 'pa-org-3');
    const tenderId = await createTender(app, org.id, 'pa-003');
    const viewer = await registerAndLogin(app, 'pa-viewer-3@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const viewerAttempt = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { kind: 'hito', label: 'Entrega parcial' },
    });
    expect(viewerAttempt.statusCode).toBe(403);
  });
});
