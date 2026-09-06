import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactorFull, stepUpWithBackupCode, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * E2E ronda 6 (REQ-051..055): adjudicado -> contrato subido -> estados ->
 * inconformidad borrador -> autopsia -> radar, en un solo flujo continuo
 * sobre la MISMA convocatoria, más pruebas adversariales de aislamiento
 * entre organizaciones.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'e2e6-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Convocatoria E2E ronda 6', contractingEntity: 'Dependencia E2E', sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('E2E ronda 6 — post-adjudicación completa (REQ-051..055)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('adjudicado -> contrato firmado subido -> ejecución -> en_inconformidad -> autopsia del fallo -> radar de renovaciones', async () => {
    const owner = await registerAndLogin(app, 'e2e6-owner@example.com');
    const org = await createOrgFor(app, owner, 'E2E6 Org', 'e2e6-org');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    // 1) Contrato en "adjudicado".
    const contract = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/contract`, headers });
    expect(contract.statusCode).toBe(201);
    expect(contract.json().status).toBe('adjudicado');

    // 2) El usuario sube el contrato firmado (declarativo) y confirma un campo extraído.
    const contractText = 'CONTRATO NÚMERO: E2E-2026-0001\nCLÁUSULA PRIMERA. Monto total: $500,000.00 pesos.';
    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/documents`,
      headers,
      payload: { filename: 'contrato.txt', mimeType: 'text/plain', contentBase64: Buffer.from(contractText, 'utf8').toString('base64') },
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().textExtractionStatus).toBe('extracted');
    const fields = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/contract/documents/${upload.json().id}/fields`, headers });
    const numeroContrato = fields.json().find((f: any) => f.fieldKey === 'numero_contrato');
    expect(numeroContrato.status).toBe('sugerido');
    await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/fields/${numeroContrato.id}/confirm`,
      headers,
      payload: { action: 'confirm' },
    });

    // 3) Declara firmado.
    await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'contrato_firmado_declarado', reason: 'Firma declarada por el proveedor.' },
    });

    // 4) Antes de iniciar la ejecución surge una controversia sobre el acto de firma -> "en_inconformidad" (exige step-up).
    const stepUpScope = { orgId: org.id, purpose: 'expediente.contract_transition' as const };
    const { backupCodes, stepUpToken } = await enrollTwoFactorFull(app, owner.accessToken, stepUpScope);
    const toInconformidad = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers: { ...headers, 'x-step-up': stepUpToken },
      payload: { toStatus: 'en_inconformidad', reason: 'Se detecta un posible motivo de inconformidad contra el acto impugnado.' },
    });
    expect(toInconformidad.statusCode).toBe(200);
    const alertJob = await db.query("select 1 from jobs where org_id = $1 and kind = 'contract_state_alert'", [org.id]);
    expect(alertJob.rows.length).toBe(1);

    // 5) Redactor de inconformidades: genera el borrador.
    const draft = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/inconformidad`,
      headers,
      payload: {
        falloNotifiedOn: '2026-01-05',
        hechos: ['Se detectó una irregularidad en el acto impugnado.'],
        agravios: ['Falta de motivación y fundamentación.'],
        pruebas: ['Bitácora del expediente.'],
      },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().status).toBe('borrador');
    expect(draft.json().disclaimer).toContain('BORRADOR');

    // 6) Resuelve la inconformidad -> regresa a contrato_firmado_declarado, y de ahí a en_ejecucion.
    const resolveToken = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[0], stepUpScope);
    await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers: { ...headers, 'x-step-up': resolveToken },
      payload: { toStatus: 'contrato_firmado_declarado', reason: 'Inconformidad resuelta sin afectar la firma.' },
    });
    const toEjecucion = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/contract/transition`,
      headers,
      payload: { toStatus: 'en_ejecucion', reason: 'Inicio de ejecución.' },
    });
    expect(toEjecucion.statusCode).toBe(200);

    // 7) Autopsia del fallo (aunque el contrato siga vigente, se documenta el aprendizaje del proceso).
    const autopsy = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/fallo-autopsy`,
      headers,
      payload: { ownProposalStatus: 'ganadora', lessons: ['Documentar cada incidencia de ejecución en tiempo real.'] },
    });
    expect(autopsy.statusCode).toBe(201);
    expect(autopsy.json().linkedToCompanyProfile).toBe(true);
    const lessons = await app.inject({ method: 'GET', url: '/expediente/lessons-learned', headers });
    expect(lessons.json().length).toBe(1);

    // 8) Radar de renovaciones: se fija la fecha de fin y se escanea.
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 25);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${tenderId}/contract`, headers, payload: { endDate: soon.toISOString().slice(0, 10) } });
    const scan = await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers, payload: { leadDaysThresholds: [30] } });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().alertsCreated).toBe(1);

    const alerts = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers });
    expect(alerts.json().items.length).toBe(1);

    // El flujo completo terminó sin ningún envío externo -- se verifica el estado final del contrato.
    const finalContract = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/contract`, headers });
    expect(finalContract.json().status).toBe('en_ejecucion');
  });

  it('adversarial: una organización NUNCA ve el contrato, extracción, inconformidad, autopsia o alertas de renovación de OTRA organización', async () => {
    const ownerA = await registerAndLogin(app, 'e2e6-orgA@example.com');
    const orgA = await createOrgFor(app, ownerA, 'E2E6 Org A', 'e2e6-org-a');
    const tenderA = await createTender(app, orgA.id, 'e2e6-a-001');
    const headersA = { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgA.id };

    const ownerB = await registerAndLogin(app, 'e2e6-orgB@example.com');
    const orgB = await createOrgFor(app, ownerB, 'E2E6 Org B', 'e2e6-org-b');
    const tenderB = await createTender(app, orgB.id, 'e2e6-b-001');
    const headersB = { authorization: `Bearer ${ownerB.accessToken}`, 'x-org-id': orgB.id };

    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderA}/contract`, headers: headersA });
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderB}/contract`, headers: headersB });

    // B no puede ver ni transicionar el contrato de A (bajo el tenderId de A, con las credenciales de B).
    const crossGet = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderA}/contract`, headers: headersB });
    expect(crossGet.statusCode).toBe(404);

    const crossTransition = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderA}/contract/transition`,
      headers: headersB,
      payload: { toStatus: 'contrato_firmado_declarado', reason: 'Intento cruzado.' },
    });
    expect(crossTransition.statusCode).toBe(404);

    // Inconformidad de A no aparece en la lista de B.
    await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderA}/inconformidad`,
      headers: headersA,
      payload: { falloNotifiedOn: '2026-01-05', hechos: ['h'], agravios: ['a'], pruebas: [] },
    });
    const listB = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderA}/inconformidad`, headers: headersB });
    expect(listB.statusCode).toBe(404); // requireTender falla primero: tenderA no pertenece a orgB.

    // Lecciones aprendidas de A no aparecen en el listado org-wide de B.
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderA}/fallo-autopsy`, headers: headersA, payload: { lessons: ['lección de A'] } });
    const lessonsB = await app.inject({ method: 'GET', url: '/expediente/lessons-learned', headers: headersB });
    expect(lessonsB.json()).toEqual([]);

    // Alertas de renovación de A no aparecen en el listado de B.
    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 10);
    await app.inject({ method: 'PATCH', url: `/expediente/tenders/${tenderA}/contract`, headers: headersA, payload: { endDate: soon.toISOString().slice(0, 10) } });
    await app.inject({ method: 'POST', url: '/expediente/renewals/scan', headers: headersA, payload: {} });
    const alertsB = await app.inject({ method: 'GET', url: '/expediente/renewals/alerts', headers: headersB });
    expect(alertsB.json().items).toEqual([]);
  });
});
