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
      payload: { kind: 'garantia', label: 'Fianza de cumplimiento', dueDate: '2027-01-15', reminderLeadDays: 5, guaranteeType: 'cumplimiento' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().jobId).toBeTruthy();
    expect(create.json().guaranteeType).toBe('cumplimiento');

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

  it('kind="hito" exige responsibleParty; kind="facturacion" exige cfdiReference + acceptanceDate y calcula el mismo plazo legal que kind="pago"', async () => {
    const owner = await registerAndLogin(app, 'pa-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'PA Org 4', 'pa-org-4');
    const tenderId = await createTender(app, org.id, 'pa-004');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const hitoSinResponsable = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'hito', label: 'Entrega de anexo técnico', dueDate: '2026-06-01' },
    });
    expect(hitoSinResponsable.statusCode).toBe(422);

    const hitoOk = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'hito', label: 'Entrega de anexo técnico', dueDate: '2026-06-01', responsibleParty: 'María López (administradora del contrato)' },
    });
    expect(hitoOk.statusCode).toBe(201);
    expect(hitoOk.json().responsibleParty).toBe('María López (administradora del contrato)');

    const facturaSinCfdi = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'facturacion', label: 'Factura #002', acceptanceDate: '2026-01-05' },
    });
    expect(facturaSinCfdi.statusCode).toBe(422);

    // 2026-01-05 es lunes; +17 días hábiles (sin feriados) cae el 2026-01-28 -- mismo cómputo que kind='pago'.
    const factura = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'facturacion', label: 'Factura #002', cfdiReference: 'ABCDEF12-3456-7890-ABCD-EF1234567890', acceptanceDate: '2026-01-05' },
    });
    expect(factura.statusCode).toBe(201);
    expect(factura.json().cfdiReference).toBe('ABCDEF12-3456-7890-ABCD-EF1234567890');
    expect(factura.json().dueDate).toContain('2026-01-28');
    expect(factura.json().legalReference).toContain('Art. 73');
  });

  it('kind="penalizacion"/"convenio_modificatorio" exigen modificationReference registrado', async () => {
    const owner = await registerAndLogin(app, 'pa-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'PA Org 5', 'pa-org-5');
    const tenderId = await createTender(app, org.id, 'pa-005');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const sinReferencia = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'penalizacion', label: 'Pena convencional por atraso', amount: 15000 },
    });
    expect(sinReferencia.statusCode).toBe(422);

    const penalizacion = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'penalizacion', label: 'Pena convencional por atraso', amount: 15000, modificationReference: 'PEN-2026-001' },
    });
    expect(penalizacion.statusCode).toBe(201);
    expect(penalizacion.json().modificationReference).toBe('PEN-2026-001');
    expect(penalizacion.json().amount).toBe(15000);

    const convenio = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'convenio_modificatorio', label: 'Convenio modificatorio de plazo', modificationReference: 'CM-2026-001' },
    });
    expect(convenio.statusCode).toBe(201);
  });

  it('alertLevel marca "vencido"/"proximo" según due_date y GET /post-award-alerts agrega todas las convocatorias de la organización', async () => {
    const owner = await registerAndLogin(app, 'pa-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'PA Org 6', 'pa-org-6');
    const tenderId = await createTender(app, org.id, 'pa-006');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const past = new Date();
    past.setUTCDate(past.getUTCDate() - 5);
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 1);
    const far = new Date();
    far.setUTCDate(far.getUTCDate() + 90);
    const toDateOnly = (d: Date) => d.toISOString().slice(0, 10);

    const vencido = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'hito', label: 'Hito vencido', dueDate: toDateOnly(past), responsibleParty: 'Responsable A', reminderLeadDays: 3 },
    });
    expect(vencido.json().alertLevel).toBe('vencido');

    const proximo = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'hito', label: 'Hito próximo', dueDate: toDateOnly(soon), responsibleParty: 'Responsable B', reminderLeadDays: 3 },
    });
    expect(proximo.json().alertLevel).toBe('proximo');

    const lejano = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'hito', label: 'Hito lejano', dueDate: toDateOnly(far), responsibleParty: 'Responsable C', reminderLeadDays: 3 },
    });
    expect(lejano.json().alertLevel).toBeNull();

    const alerts = await app.inject({ method: 'GET', url: '/expediente/post-award-alerts', headers });
    expect(alerts.statusCode).toBe(200);
    const labels = alerts.json().map((a: { label: string }) => a.label);
    expect(labels).toContain('Hito vencido');
    expect(labels).toContain('Hito próximo');
    expect(labels).not.toContain('Hito lejano');
  });
});
