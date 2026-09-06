import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, enrollTwoFactorFull, stepUpWithBackupCode, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * E8 — `IntegrityChecklist` persistida y `ApprovalWorkflow` real (roles
 * reviewer/admin/owner; autoaprobación prohibida; comentarios; invalidación
 * automática al cambiar un insumo). Cobertura: A11 (edición de un insumo ya
 * aprobado invalida la aprobación), A12 (rol indebido no puede aprobar).
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'chk-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Servicio de limpieza', sourceVersion: 'v1', submissionDeadline: '2099-01-01T00:00:00Z' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('expediente — checklist de integridad y flujo de aprobación (E8)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('ejecuta el checklist real (7 dimensiones) y lo persiste en compliance_items', async () => {
    const owner = await registerAndLogin(app, 'chk-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Chk Org 1', 'chk-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers }); // asegura que exista el expediente

    const run = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/checklist/run`,
      headers,
      payload: { files: [{ filename: 'anexo.pdf', extension: 'pdf', sizeBytes: 1000 }], formatLimits: { allowedExtensions: ['pdf'], maxFileSizeBytes: 5_000_000, maxUploadSlots: 5 } },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().items.length).toBe(7);
    expect(run.json().items.map((i: any) => i.dimension).sort()).toEqual(
      ['anexos_obligatorios', 'calculos_economicos', 'consistencia_cruzada', 'firmas', 'formatos', 'limites', 'vigencias'].sort()
    );
    // Sin propuesta económica generada todavía: la dimensión económica es roja (nunca "verde" por defecto).
    expect(run.json().items.find((i: any) => i.dimension === 'calculos_economicos').result).toBe('rojo');
    expect(run.json().overallStatus).toBe('rojo');

    const persisted = await db.query('select dimension, result from compliance_items where org_id = $1', [org.id]);
    expect(persisted.rows.length).toBe(7);

    const get = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/checklist`, headers });
    expect(get.statusCode).toBe(200);
    expect(get.json().items.length).toBe(7);
  });

  it('A12: writer no puede aprobar (solo reviewer/admin/owner); autoaprobación (mismo actor) prohibida; comentarios visibles', async () => {
    const owner = await registerAndLogin(app, 'chk-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Chk Org 2', 'chk-org-2');
    const tenderId = await createTender(app, org.id, 'chk-002');
    const { stepUpToken: ownerStepUp } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' });
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': ownerStepUp };

    const writer = await registerAndLogin(app, 'chk-writer-2@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, writer.id]);
    const writerHeaders = { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id };

    const reviewer = await registerAndLogin(app, 'chk-reviewer-2@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'reviewer')", [org.id, reviewer.id]);
    // R5-09: single-use -- el reviewer aprueba DOS veces en este test (dos
    // alcances distintos), así que necesita DOS tokens independientes.
    const reviewerScope = { orgId: org.id, purpose: 'expediente.approval' as const };
    const { backupCodes: reviewerBackupCodes } = await enrollTwoFactorFull(app, reviewer.accessToken, reviewerScope);
    const reviewerStepUp = await stepUpWithBackupCode(app, reviewer.accessToken, reviewerBackupCodes[0], reviewerScope);
    const reviewerStepUp2 = await stepUpWithBackupCode(app, reviewer.accessToken, reviewerBackupCodes[1], reviewerScope);
    const reviewerHeaders = { authorization: `Bearer ${reviewer.accessToken}`, 'x-org-id': org.id, 'x-step-up': reviewerStepUp };

    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers: ownerHeaders });

    // writer envía a revisión (rol permitido para enviar, no para aprobar).
    const request = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/request-review`, headers: writerHeaders, payload: { scopeRef: 'expediente' } });
    expect(request.statusCode).toBe(200);
    expect(request.json().state).toBe('en_revision');

    // A12: writer NUNCA puede aprobar, sin importar que haya sido quien envió a revisión.
    const writerApprove = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers: writerHeaders,
      payload: { scope: 'expediente', scopeRef: 'expediente' },
    });
    expect(writerApprove.statusCode).toBe(403);

    // Comentario del writer, visible para el reviewer.
    const comment = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/comments`, headers: writerHeaders, payload: { scopeRef: 'expediente', text: 'Falta revisar el anexo económico.' } });
    expect(comment.statusCode).toBe(200);
    expect(comment.json().comments.some((c: any) => c.text.includes('Falta revisar'))).toBe(true);

    // reviewer aprueba (rol correcto, actor distinto de quien envió a revisión).
    const reviewerApprove = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers: reviewerHeaders,
      payload: { scope: 'expediente', scopeRef: 'expediente' },
    });
    expect(reviewerApprove.statusCode).toBe(200);
    expect(reviewerApprove.json().state).toBe('aprobado');
    expect(reviewerApprove.json().fullyApproved).toBe(true);

    // Autoaprobación prohibida: `owner` es a la vez rol admitido para
    // ENVIAR a revisión y para APROBAR -- si envía y luego intenta aprobar
    // su propio envío (mismo actorId), debe rechazarse (EX-EXP no aplica
    // aquí; es la regla base de ApprovalWorkflow.approve()).
    const ownerSubmits = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/request-review`, headers: ownerHeaders, payload: { scopeRef: 'documento:tecnica' } });
    expect(ownerSubmits.statusCode).toBe(200);
    const selfApprove = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers: ownerHeaders,
      payload: { scope: 'documento', scopeRef: 'documento:tecnica' },
    });
    expect(selfApprove.statusCode).toBe(403);

    // Un actor DISTINTO (reviewer) sí puede aprobar ese mismo alcance --
    // con su SEGUNDO token (R5-09: el primero ya se consumió arriba).
    const otherApproves = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers: { ...reviewerHeaders, 'x-step-up': reviewerStepUp2 },
      payload: { scope: 'documento', scopeRef: 'documento:tecnica' },
    });
    expect(otherApproves.statusCode).toBe(200);
  });

  it('A11: cambiar un insumo real (perfil de empresa) después de aprobar invalida la aprobación automáticamente', async () => {
    const owner = await registerAndLogin(app, 'chk-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Chk Org 3', 'chk-org-3');
    const tenderId = await createTender(app, org.id, 'chk-003');
    const { stepUpToken: ownerStepUp } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'expediente.approval' });
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': ownerStepUp };

    await app.inject({ method: 'PUT', url: '/company/profile', headers: ownerHeaders, payload: { legalName: 'Original SA de CV' } });
    await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers: ownerHeaders });

    const approve = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/approve`, headers: ownerHeaders, payload: { scope: 'expediente', scopeRef: 'expediente' } });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().fullyApproved).toBe(true);

    // Insumo real (perfil de empresa, forma parte de ExpedienteInputs.companyProfileHash) cambia DESPUÉS de aprobar.
    await app.inject({ method: 'PUT', url: '/company/profile', headers: ownerHeaders, payload: { legalName: 'Razón social modificada SA de CV' } });

    const after = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/approval`, headers: ownerHeaders });
    expect(after.statusCode).toBe(200);
    expect(after.json().fullyApproved).toBe(false);
  });
});
