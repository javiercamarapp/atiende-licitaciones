import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * AE-14 (docs/auditoria-2/api-expediente-reverificacion.md, MEDIA):
 * GET /package/latest y /package/download servían el ZIP/estado "ready"
 * guardado en la última fila de package_manifests, incluso después de que
 * la aprobación vigente quedara invalidada (p. ej. por editar una sección,
 * AE-02) -- nunca re-derivaban el estado real.
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

describe('AE-14: GET /package/latest y /package/download re-derivan el estado real (no sirven el "ready" viejo)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('paquete "ready" -> invalidar la aprobación (editar sección) -> /package/latest reporta "draft"; /package/download responde 409, nunca el ZIP viejo', async () => {
    const owner = await registerAndLogin(app, 'ae14-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'AE14 Org 1', 'ae14-org-1');
    const tenderId = await createTender(app, org.id, 'ae14-001');
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' });
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };

    const proposalRes = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers });
    const proposalId = proposalRes.json().id;

    // Checklist verde real: siembra los compliance_items de las 7
    // dimensiones directamente como "verde" (más simple/estable que
    // recorrer todo el flujo de checklist/run con anexos/firmas reales,
    // que no es el objeto de este test).
    const dimensions = ['anexos_obligatorios', 'calculos_economicos', 'consistencia_cruzada', 'firmas', 'formatos', 'limites', 'vigencias'];
    for (const dimension of dimensions) {
      await db.query(
        "insert into compliance_items (org_id, tender_id, proposal_id, dimension, label, result) values ($1, $2, $3, $4, $4, 'verde')",
        [org.id, tenderId, proposalId, dimension]
      );
    }

    await db.query(
      "insert into proposal_sections (org_id, proposal_id, section_key, title, content) values ($1, $2, 'demo', 'Sección de prueba', 'contenido original')",
      [org.id, proposalId]
    );

    const approve = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers,
      payload: { scope: 'expediente', scopeRef: 'expediente' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().fullyApproved).toBe(true);

    const assemble = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
    expect(assemble.statusCode).toBe(200);
    expect(assemble.json().status).toBe('ready');

    const latestBefore = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/package/latest`, headers });
    expect(latestBefore.json().status).toBe('ready');

    const downloadBefore = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/package/download`, headers });
    expect(downloadBefore.statusCode).toBe(200);

    // Invalida la aprobación editando el contenido de la sección (AE-02).
    const editRes = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/proposal/sections/demo`,
      headers,
      payload: { content: 'contenido modificado después de aprobar' },
    });
    expect(editRes.statusCode).toBe(200);

    // AE-14: /package/latest YA NO reporta "ready" sin un nuevo assemble.
    const latestAfter = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/package/latest`, headers });
    expect(latestAfter.statusCode).toBe(200);
    expect(latestAfter.json().status).toBe('draft');
    expect(latestAfter.json().draftReasons.length).toBeGreaterThan(0);

    // AE-14: /package/download rechaza con 409 explícito, nunca el ZIP viejo.
    const downloadAfter = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/package/download`, headers });
    expect(downloadAfter.statusCode).toBe(409);
  });
});
