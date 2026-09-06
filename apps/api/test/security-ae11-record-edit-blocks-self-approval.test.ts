import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * AE-11 (docs/auditoria-2/api-expediente.md, BAJA): `ApprovalWorkflow.
 * approve()` solo comparaba el `actorId` de quien pidió revisión contra
 * quien aprueba -- un actor que REDACTÓ el contenido de una sección podía,
 * si OTRA persona pidió la revisión, aprobar igual el expediente completo.
 * `packages/expediente` agregó `recordEdit`/`authorsOf` (aditivo); esta
 * corrección cablea `apps/api` (`PATCH .../proposal/sections/:sectionKey`)
 * para que la protección tenga efecto real.
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

describe('AE-11: quien editó el contenido de una sección no puede aprobar ese alcance, aunque otra persona haya pedido revisión', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('writer edita una sección -> luego promovido a reviewer -> intenta aprobar "expediente" -> 403 explícito (autor de contenido)', async () => {
    const owner = await registerAndLogin(app, 'ae11-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'AE11 Org 1', 'ae11-org-1');
    const tenderId = await createTender(app, org.id, 'ae11-001');
    const ownerHeaders = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const editor = await registerAndLogin(app, 'ae11-editor-1@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, editor.id]);
    const editorHeaders = { authorization: `Bearer ${editor.accessToken}`, 'x-org-id': org.id };

    // Asegura que exista el expediente, y siembra una sección directamente
    // (más simple/estable que pasar por technical/economic generate, que
    // exigen mapeos/tarifas aprobadas fuera del alcance de este test).
    const proposalRes = await app.inject({ method: 'GET', url: `/expediente/tenders/${tenderId}/proposal`, headers: ownerHeaders });
    const proposalId = proposalRes.json().id;
    await db.query(
      "insert into proposal_sections (org_id, proposal_id, section_key, title, content) values ($1, $2, 'demo', 'Sección de prueba', 'contenido inicial')",
      [org.id, proposalId]
    );

    // El writer edita el contenido de esa sección (AE-11: queda registrado como autor de `seccion:demo`).
    const editRes = await app.inject({
      method: 'PATCH',
      url: `/expediente/tenders/${tenderId}/proposal/sections/demo`,
      headers: editorHeaders,
      payload: { content: 'Texto redactado por el writer.' },
    });
    expect(editRes.statusCode).toBe(200);

    // OTRA persona (owner) pide la revisión del expediente completo.
    const requestReview = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/request-review`,
      headers: ownerHeaders,
      payload: { scopeRef: 'expediente' },
    });
    expect(requestReview.statusCode).toBe(200);

    // El writer editor es promovido a reviewer (rol habilitado para aprobar).
    await db.query("update memberships set role = 'reviewer' where org_id = $1 and user_id = $2", [org.id, editor.id]);

    // AE-11: aunque el editor NO fue quien pidió revisión (eso lo hizo el
    // owner) y AHORA sí tiene rol reviewer, se le rechaza aprobar
    // "expediente" porque consta como autor de contenido de una sección
    // cubierta por ese alcance.
    const selfApprove = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers: editorHeaders,
      payload: { scope: 'expediente', scopeRef: 'expediente' },
    });
    expect(selfApprove.statusCode).toBe(403);
    expect(selfApprove.json().title).toMatch(/actor_autor_de_contenido/);

    // Un TERCERO (ni el que pidió revisión -- el owner -- ni quien editó
    // contenido -- el editor) SÍ puede aprobar: la protección de AE-11 es
    // específica de autoría de contenido, no bloquea a cualquiera.
    const thirdReviewer = await registerAndLogin(app, 'ae11-reviewer-1@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'reviewer')", [org.id, thirdReviewer.id]);
    const otherApprove = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/approval/approve`,
      headers: { authorization: `Bearer ${thirdReviewer.accessToken}`, 'x-org-id': org.id },
      payload: { scope: 'expediente', scopeRef: 'expediente' },
    });
    expect(otherApprove.statusCode).toBe(200);
    expect(otherApprove.json().fullyApproved).toBe(true);
  });
});
