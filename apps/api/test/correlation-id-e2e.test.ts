import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactorFull, stepUpWithBackupCode, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * REQ-171 (extiende REQ-084 al ciclo completo del expediente): un
 * `correlation_id` único, heredado de `X-Correlation-Id` o generado por
 * request, debe propagarse a `audit_log` a lo largo de TODO un flujo
 * multi-request (convocatoria -> propuesta -> checklist -> aprobación ->
 * paquete), reconstruible con `GET /audit-log?correlationId=`.
 */
async function createTender(app: FastifyInstance, orgId: string, externalId = 'corr-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Servicio de mensajería', sourceVersion: 'v1', submissionDeadline: '2099-01-01T00:00:00Z' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('REQ-171 — correlation_id de extremo a extremo', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('sin X-Correlation-Id, la API genera uno y lo refleja en la respuesta; con un UUID inválido, lo ignora y genera uno propio (nunca rechaza la request)', async () => {
    const owner = await registerAndLogin(app, 'corr-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Corr Org 1', 'corr-org-1');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const generated = await app.inject({ method: 'GET', url: '/company/profile', headers });
    expect(generated.statusCode).toBe(200);
    expect(generated.headers['x-correlation-id']).toBeTruthy();

    const withInvalid = await app.inject({ method: 'GET', url: '/company/profile', headers: { ...headers, 'x-correlation-id': 'no-es-un-uuid' } });
    expect(withInvalid.statusCode).toBe(200);
    expect(withInvalid.headers['x-correlation-id']).not.toBe('no-es-un-uuid');

    const validId = '11111111-2222-4333-8444-555555555555';
    const withValid = await app.inject({ method: 'GET', url: '/company/profile', headers: { ...headers, 'x-correlation-id': validId } });
    expect(withValid.headers['x-correlation-id']).toBe(validId);
  });

  it('un flujo completo (propuesta económica -> checklist -> aprobación -> ensamblado de paquete) con el MISMO correlation_id se reconstruye por completo en GET /audit-log?correlationId=', async () => {
    const owner = await registerAndLogin(app, 'corr-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Corr Org 2', 'corr-org-2');
    const tenderId = await createTender(app, org.id, 'corr-002');
    const correlationId = '99999999-8888-4777-8666-555555555555';
    // R5-09: dos acciones con purposes distintos -- dos sesiones de step-up.
    const { backupCodes } = await enrollTwoFactorFull(app, owner.accessToken, { orgId: org.id, purpose: 'company.rate_approval' });
    const rateStepUp = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[0], { orgId: org.id, purpose: 'company.rate_approval' });
    const expedienteStepUp = await stepUpWithBackupCode(app, owner.accessToken, backupCodes[1], { orgId: org.id, purpose: 'expediente.approval' });
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-correlation-id': correlationId };

    await app.inject({ method: 'PUT', url: '/company/profile', headers, payload: { legalName: 'Mensajería Rápida SA de CV', taxId: 'MRA010101AAA' } });
    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'envio-local', description: 'Envío local', unitPrice: 120, validFrom: '2020-01-01' } });
    await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers: { ...headers, 'x-step-up': rateStepUp } });

    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });
    const economic = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
      headers,
      payload: { lineItems: [{ concept: 'envio-local', quantity: 5 }] },
    });
    expect(economic.statusCode).toBe(200);
    expect(economic.headers['x-correlation-id']).toBe(correlationId);

    const checklist = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/checklist/run`,
      headers,
      payload: { files: [], formatLimits: { allowedExtensions: ['pdf'], maxFileSizeBytes: 5_000_000, maxUploadSlots: 5 }, requiredSignatures: [] },
    });
    expect(checklist.json().overallStatus).toBe('verde');

    const approve = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/approve`, headers: { ...headers, 'x-step-up': expedienteStepUp }, payload: { scope: 'expediente', scopeRef: 'expediente' } });
    expect(approve.json().fullyApproved).toBe(true);

    const assemble = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
    expect(assemble.statusCode).toBe(200);
    expect(assemble.json().status).toBe('ready');

    // Un evento de OTRO flujo (sin este correlation_id) no debe aparecer al filtrar.
    const otherOrgOwner = await registerAndLogin(app, 'corr-owner-3@example.com');
    const otherOrg = await createOrgFor(app, otherOrgOwner, 'Corr Org 3', 'corr-org-3');
    await app.inject({
      method: 'PUT',
      url: '/company/profile',
      headers: { authorization: `Bearer ${otherOrgOwner.accessToken}`, 'x-org-id': otherOrg.id },
      payload: { legalName: 'Otra Empresa' },
    });

    const trace = await app.inject({
      method: 'GET',
      url: `/audit-log?correlationId=${correlationId}&limit=100`,
      headers,
    });
    expect(trace.statusCode).toBe(200);
    const entities = trace.json().items.map((e: { entity: string; correlationId: string | null }) => {
      expect(e.correlationId).toBe(correlationId);
      return e.entity;
    });
    // Reconstruye la cadena: perfil de empresa -> tarifa -> propuesta -> checklist -> aprobación -> paquete.
    expect(entities).toContain('company_profiles');
    expect(entities).toContain('approved_rates');
    expect(entities).toContain('proposals');
    expect(entities).toContain('compliance_items');
    expect(entities).toContain('proposal_approvals');
    expect(entities).toContain('package_manifests');
    expect(entities).not.toContain('company_profiles_de_otra_org');

    // El manifiesto DENTRO del ZIP también lleva el correlation_id (aditivo, packages/expediente).
    const dbRow = await db.query<{ manifest: { correlationId?: string | null } }>(
      'select manifest from package_manifests where org_id = $1 order by generated_at desc limit 1',
      [org.id]
    );
    expect(dbRow.rows[0].manifest.correlationId).toBe(correlationId);

    // El evento del otro org, con OTRO correlation_id, no aparece.
    const otherProfile = await db.query('select correlation_id from audit_log where entity = $1 and org_id = $2', ['company_profiles', otherOrg.id]);
    expect(otherProfile.rows[0].correlation_id).not.toBe(correlationId);
  });
});
