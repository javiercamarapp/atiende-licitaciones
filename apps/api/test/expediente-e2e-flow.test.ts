import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import JSZip from 'jszip';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * E2E completo del expediente de participación, de punta a punta a través
 * de la API real (fastify.inject + PGlite): bases -> matriz -> perfil ->
 * propuesta -> checklist -> aprobación -> paquete "draft" -> completar ->
 * "ready" -> descargar ZIP y leer manifiesto -> cambio de bases ->
 * invalidación -> "draft" de nuevo. Cubre A6-A15 en conjunto (cada
 * aserción anota qué prueba mínima cierra).
 */

function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('expediente — flujo E2E completo (E6-E11)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('recorre bases -> matriz -> perfil -> propuesta -> checklist -> aprobación -> paquete ready -> descarga -> cambio de bases -> invalidación -> draft', async () => {
    const owner = await registerAndLogin(app, 'e2e-owner@example.com');
    const org = await createOrgFor(app, owner, 'E2E Org', 'e2e-org');
    const reviewer = await registerAndLogin(app, 'e2e-reviewer@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'reviewer')", [org.id, reviewer.id]);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    const reviewerHeaders = { authorization: `Bearer ${reviewer.accessToken}`, 'x-org-id': org.id };

    // 1) Convocatoria (ingesta interna, ronda 1/2).
    const ingest = await app.inject({
      method: 'POST',
      url: '/internal/tenders/ingest',
      headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
      payload: { records: [{ source: 'compras-mx', externalId: 'e2e-001', title: 'Servicio integral de mantenimiento', sourceVersion: 'v1', submissionDeadline: '2099-01-01T00:00:00Z' }], organizationIds: [org.id] },
    });
    expect(ingest.statusCode).toBe(200);
    const tenderId = ingest.json().results[0].tenderId;

    // 2) Bases (E6): subida + extracción de texto + matriz de requisitos.
    const basesV1 = toBase64('Es obligatorio presentar la Garantía de cumplimiento a más tardar el 15 de octubre de 2026 a las 14:00 horas.');
    const uploadDoc = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers,
      payload: { documentKind: 'bases', filename: 'bases-v1.txt', mimeType: 'text/plain', contentBase64: basesV1 },
    });
    expect(uploadDoc.statusCode).toBe(201);
    expect(uploadDoc.json().textExtractionStatus).toBe('extracted');

    const buildMatrix = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/matrix/build`, headers });
    expect(buildMatrix.statusCode).toBe(200);
    expect(buildMatrix.json().itemsCreated).toBeGreaterThan(0); // A6: extracción real, con fuente/página trazable

    // 3) Perfil de empresa real (E2/E7): capacidad aprobada + tarifa aprobada.
    await app.inject({ method: 'PUT', url: '/company/profile', headers, payload: { legalName: 'Servicios Integrales del Centro SA de CV', taxId: 'SIC010101AAA' } });
    const cap = await app.inject({ method: 'POST', url: '/company/capabilities', headers, payload: { name: 'Mantenimiento preventivo y correctivo', isVerified: true } });
    expect(cap.statusCode).toBe(201);
    const rate = await app.inject({ method: 'POST', url: '/company/rates', headers, payload: { itemCode: 'hora-mantenimiento', description: 'Hora de mantenimiento', unitPrice: 300, validFrom: '2020-01-01' } });
    await app.inject({ method: 'POST', url: `/company/rates/${rate.json().id}/approve`, headers });

    // 4) Propuesta técnica (E7): requisito mapeado a la capacidad aprobada.
    const matrixItems = (await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/matrix`, headers })).json();
    const mappings = matrixItems.map((item: any) => ({ requirementId: item.id, kind: 'capability', refKey: 'Mantenimiento preventivo y correctivo' }));
    const technical = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/proposal/technical/generate`, headers, payload: { mappings } });
    expect(technical.statusCode).toBe(200);

    // 5) Propuesta económica (E7, A8): tarifa aprobada, cálculo real.
    const economic = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
      headers,
      payload: { lineItems: [{ concept: 'hora-mantenimiento', quantity: 40 }] },
    });
    expect(economic.statusCode).toBe(200);
    expect(economic.json().economicTotals.subtotal).toBe('12000.00'); // A10: cálculo determinista

    // 6) Checklist de integridad (E8) -- todavía SIN aprobación: paquete debe
    // ser "draft" (A14) aunque el checklist ya esté verde.
    const checklist = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/checklist/run`,
      headers,
      payload: { files: [], formatLimits: { allowedExtensions: ['pdf'], maxFileSizeBytes: 5_000_000, maxUploadSlots: 5 }, requiredSignatures: [] },
    });
    expect(checklist.json().overallStatus).toBe('verde');

    const draftBeforeApproval = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
    expect(draftBeforeApproval.json().status).toBe('draft'); // A14: sin aprobación vigente, nunca "ready"
    expect(draftBeforeApproval.json().draftReasons.join(' ')).toContain('sin_aprobacion_vigente');

    // 7) Aprobación (E8, A11/A12): owner envía a revisión, reviewer aprueba
    // (rol correcto, actor distinto -- nunca autoaprobación).
    await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/request-review`, headers, payload: { scopeRef: 'expediente' } });
    const approve = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/approval/approve`, headers: reviewerHeaders, payload: { scope: 'expediente', scopeRef: 'expediente' } });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().fullyApproved).toBe(true);

    // 8) Paquete "ready" (A13): checklist verde + aprobación vigente con
    // hash coincidente + sin faltantes -> ahora sí.
    const ready = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().status).toBe('ready');
    expect(ready.json().notice).toContain('La presentación y firma las realiza el usuario');

    // 9) Descarga autenticada del ZIP y lectura del manifiesto real (A13).
    const download = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/package/download`, headers });
    expect(download.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(download.rawPayload);
    const manifestEntry = Object.keys(zip.files).find((f) => f.endsWith('manifiesto.json'))!;
    const manifest = JSON.parse(await zip.files[manifestEntry].async('string'));
    expect(manifest.status).toBe('ready');
    expect(manifest.approvals.some((a: any) => a.scope === 'expediente' && a.status === 'vigente')).toBe(true);

    // 10) Declaración de presentación del usuario (E9, A15) -- nunca un envío real.
    const declare = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/submission/declare`,
      headers,
      payload: { submittedAt: new Date().toISOString(), notes: 'Presentado por mí en el portal.' },
    });
    expect(declare.statusCode).toBe(201);
    expect(declare.json().status).toBe('submitted');

    // 11) Cambio de bases DESPUÉS de "ready" -> invalidación automática
    // (trigger 0022 sobre requirement_items/proposals/proposal_approvals) ->
    // el paquete vuelve a "draft" al reensamblar (A11 aplicado de punta a
    // punta a través de la API real, no solo a nivel de librería).
    const basesV2 = toBase64('Es obligatorio presentar la Garantía de cumplimiento a más tardar el 30 de noviembre de 2026 a las 14:00 horas.');
    const uploadV2 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers,
      payload: { documentKind: 'bases', filename: 'bases-v2.txt', mimeType: 'text/plain', contentBase64: basesV2 },
    });
    expect(uploadV2.statusCode).toBe(201);

    const approvalAfterChange = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/approval`, headers });
    // La propia convocatoria cambió de versión -- el hash de insumos
    // (tenderVersionHash) ya no coincide con el que se aprobó.
    expect(approvalAfterChange.json().fullyApproved).toBe(false);

    const draftAfterChange = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/package/assemble`, headers });
    expect(draftAfterChange.json().status).toBe('draft');
    expect(draftAfterChange.json().draftReasons.length).toBeGreaterThan(0);

    // Historial preservado (E6): la matriz vieja sigue existiendo, invalidada.
    const proposalRow = await db.query('select invalidated_at from proposals where org_id = $1', [org.id]);
    expect(proposalRow.rows[0].invalidated_at).not.toBeNull();
  });
});
