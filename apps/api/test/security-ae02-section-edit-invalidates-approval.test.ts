import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * AE-02 (docs/auditoria-2/api-expediente.md, ALTA): `PATCH
 * /proposal/sections/:sectionKey` editaba el CONTENIDO de una sección ya
 * aprobada (alcance "expediente", vigente) SIN invalidar la aprobación --
 * `ExpedienteInputs` nunca incluye el contenido de `proposal_sections`, así
 * que `isFullyApprovedForCurrentHash` nunca detectaba el cambio por sí
 * sola (a diferencia de `conditionEvaluations`, que SÍ invoca
 * `workflow.recordChange` explícitamente). Un expediente podía quedar
 * "ready" (paquete ensamblado) con contenido reescrito DESPUÉS de la
 * revisión humana, sin que nadie lo volviera a aprobar.
 *
 * Fijado: `proposal.routes.ts` (PATCH de sección) ahora invoca
 * `workflow.recordChange({scope:'seccion', scopeRef:'seccion:<sectionKey>'})`
 * explícitamente -- el mismo mecanismo que ya usa `conditionEvaluations` --
 * cada vez que el contenido efectivamente cambia.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'ae02-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: {
      records: [{ source: 'compras-mx', externalId, title: 'Servicio de prueba AE-02', sourceVersion: 'v1', submissionDeadline: '2099-01-01T00:00:00Z' }],
      organizationIds: [orgId],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

async function insertRequirement(db: DbClient, orgId: string, tenderId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into requirement_items (id, org_id, tender_id, category, description, is_mandatory, obligatoriedad, requirement_kind, matrix_status, extracted_by, required_evidence)
     values ($1, $2, $3, 'administrativo', 'Requisito de prueba AE-02.', true, 'obligatorio', 'administrativo', 'pendiente', 'rule', $4)`,
    [id, orgId, tenderId, ['evidencia_generica']]
  );
  return id;
}

describe('AE-02: editar el contenido de una sección tras una aprobación vigente la invalida', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('aprobar -> editar sección -> el expediente vuelve a estado "sin aprobar" (fullyApproved:false, aprobación invalidada)', async () => {
    const owner = await registerAndLogin(app, 'ae02-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'AE02 Org 1', 'ae02-org-1');
    const tenderId = await createTender(app, org.id);
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };

    const reqId = await insertRequirement(db, org.id, tenderId);
    const generate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/technical/generate`,
      headers,
      payload: { mappings: [] },
    });
    expect(generate.statusCode).toBe(200);
    const sectionKey = `technical:${reqId}`;

    const approve = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers,
      payload: { scope: 'expediente', scopeRef: 'expediente' },
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().fullyApproved).toBe(true);

    // Editar manualmente el CONTENIDO de la sección (mismo mecanismo que ya
    // exige invalidación para conditionEvaluations/cambio de bases).
    const patch = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/proposal/sections/${sectionKey}`,
      headers,
      payload: { content: 'Contenido reescrito manualmente DESPUÉS de la aprobación.' },
    });
    expect(patch.statusCode).toBe(200);

    const afterEdit = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/approval`, headers });
    expect(afterEdit.json().fullyApproved).toBe(false);
    const expedienteApproval = afterEdit.json().approvals.find((a: any) => a.scope === 'expediente' && a.scopeRef === 'expediente');
    expect(expedienteApproval.status).toBe('invalidada');

    // El paquete nunca debe quedar "ready" con la aprobación invalidada.
    const pkg = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
    expect(pkg.statusCode).toBe(200);
    expect(pkg.json().status).toBe('draft');
  });

  it('editar una sección SIN cambiar el contenido (mismo texto) no invalida ninguna aprobación vigente', async () => {
    const owner = await registerAndLogin(app, 'ae02-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'AE02 Org 2', 'ae02-org-2');
    const tenderId = await createTender(app, org.id, 'ae02-002');
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };

    const reqId = await insertRequirement(db, org.id, tenderId);
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/proposal/technical/generate`, headers, payload: { mappings: [] } });
    const sectionKey = `technical:${reqId}`;

    const sectionsBefore = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal/sections`, headers });
    const currentContent = sectionsBefore.json().find((s: any) => s.sectionKey === sectionKey).content;

    const approve = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers,
      payload: { scope: 'expediente', scopeRef: 'expediente' },
    });
    expect(approve.statusCode).toBe(200);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/proposal/sections/${sectionKey}`,
      headers,
      payload: { content: currentContent },
    });
    expect(patch.statusCode).toBe(200);

    const afterEdit = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/approval`, headers });
    expect(afterEdit.json().fullyApproved).toBe(true);
  });
});
