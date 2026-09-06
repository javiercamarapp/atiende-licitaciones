import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * AE-08 (docs/auditoria-2/api-expediente.md, MEDIA): `ExpedienteInputs.
 * companyProfileHash` (`lib/expediente/inputs.ts`) solo cubría columnas de
 * `company_profiles`, ignorando `capabilities`/`experience_records`/
 * `authorized_signatories` (y, en esta corrección, también
 * `products_services`/`locations`/`registrations`/`restrictions`) pese a
 * que alimentan el contenido real de la propuesta técnica. Un cambio
 * posterior a la aprobación en un firmante ya usado no disparaba ninguna
 * invalidación.
 */
async function createTender(app: FastifyInstance, orgId: string, externalId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Servicio de limpieza', sourceVersion: 'v1', submissionDeadline: '2099-01-01T00:00:00Z' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('AE-08: companyProfileHash cubre capabilities/experience/signatories/... (no solo company_profiles)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('cambiar un FIRMANTE (authorized_signatories) después de aprobar invalida la aprobación automáticamente', async () => {
    const owner = await registerAndLogin(app, 'ae08-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'AE08 Org 1', 'ae08-org-1');
    const tenderId = await createTender(app, org.id, 'ae08-001');
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' });
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };

    const signatory = await app.inject({
      method: 'POST',
      url: '/company/signatories',
      headers,
      payload: { fullName: 'Firmante Original' },
    });
    expect(signatory.statusCode).toBe(201);
    const signatoryId = signatory.json().id;

    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });

    const approve = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers,
      payload: { scope: 'expediente', scopeRef: 'expediente' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().fullyApproved).toBe(true);

    // Cambia el firmante (insumo real, ahora parte de companyProfileHash) DESPUÉS de aprobar.
    const update = await app.inject({
      method: 'PATCH',
      url: `/company/signatories/${signatoryId}`,
      headers,
      payload: { fullName: 'Firmante Modificado' },
    });
    expect(update.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/approval`, headers });
    expect(after.statusCode).toBe(200);
    expect(after.json().fullyApproved).toBe(false);
  });

  it('cambiar una CAPABILITY después de aprobar también invalida la aprobación', async () => {
    const owner = await registerAndLogin(app, 'ae08-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'AE08 Org 2', 'ae08-org-2');
    const tenderId = await createTender(app, org.id, 'ae08-002');
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' });
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };

    const capability = await app.inject({ method: 'POST', url: '/company/capabilities', headers, payload: { name: 'Limpieza industrial' } });
    expect(capability.statusCode).toBe(201);
    const capabilityId = capability.json().id;

    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });
    const approve = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers,
      payload: { scope: 'expediente', scopeRef: 'expediente' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().fullyApproved).toBe(true);

    await app.inject({ method: 'PATCH', url: `/company/capabilities/${capabilityId}`, headers, payload: { description: 'Actualizado tras aprobar' } });

    const after = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/approval`, headers });
    expect(after.json().fullyApproved).toBe(false);
  });
});
