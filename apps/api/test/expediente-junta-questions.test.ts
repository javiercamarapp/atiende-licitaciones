import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * REQ-041 — generador de preguntas de junta de aclaraciones con fuente
 * verificable. Integración real contra Postgres (PGlite): sube documentos
 * reales, construye la matriz de requisitos real y genera preguntas fundadas
 * a partir de ella -- nunca sobre datos fabricados.
 */
function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function createTender(app: FastifyInstance, orgId: string, externalId = 'jq-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: {
      records: [{ source: 'compras-mx', externalId, title: 'Servicio de mantenimiento', sourceVersion: 'v1' }],
      organizationIds: [orgId],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('expediente — generador de preguntas de junta con sources (REQ-041)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('genera una pregunta fundada con sources reales cuando dos versiones de bases fijan plazos distintos para el mismo tema', async () => {
    const owner = await registerAndLogin(app, 'jq-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'JQ Org 1', 'jq-org-1');
    const tenderId = await createTender(app, org.id, 'jq-001');

    const doc1 = toBase64('La entrega de proposiciones sera a mas tardar el 10 de octubre de 2026 a las 10:00 horas.');
    const upload1 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'bases-v1.txt', mimeType: 'text/plain', contentBase64: doc1 },
    });
    expect(upload1.statusCode).toBe(201);

    const doc2 = toBase64('Se adelanta la entrega de proposiciones para el 5 de octubre de 2026 a las 09:00 horas.');
    const upload2 = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'aclaracion', filename: 'acta-1.txt', mimeType: 'text/plain', contentBase64: doc2 },
    });
    expect(upload2.statusCode).toBe(201);

    const generate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/junta-questions/generate`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { juntaAclaracionesAt: '2026-09-25T10:00:00-06:00' },
    });
    expect(generate.statusCode).toBe(201);
    const body = generate.json();

    expect(body.documentsUsed).toBe(2);
    expect(body.questions.length).toBeGreaterThan(0);
    const q = body.questions.find((x: any) => x.reason === 'conflicto_plazo');
    expect(q).toBeTruthy();
    // Invariante REQ-041/REQ-082: toda pregunta trae al menos una fuente
    // verificable con documento+página+cita real.
    expect(q.sources.length).toBeGreaterThan(0);
    for (const s of q.sources) {
      expect(s.documentId).toBeTruthy();
      expect(s.page).toBeGreaterThan(0);
      expect(s.quote.length).toBeGreaterThan(0);
    }
    expect(q.question).toContain('10 de octubre');
    expect(q.question).toContain('5 de octubre');

    // Ventana de 24h (REQ-041): la junta es a las 10:00 del 25-sep, el
    // límite para preguntas fundadas es 24h antes.
    expect(new Date(body.questionsDueAt).toISOString()).toBe(new Date('2026-09-24T10:00:00-06:00').toISOString());

    // El 100% de las preguntas de TODA la respuesta cumple la invariante.
    for (const question of body.questions) {
      expect(question.sources.length).toBeGreaterThan(0);
    }

    // La corrida queda persistida en el historial (append-only, GET).
    const list = await app.inject({
      method: 'GET',
      url: `/expediente/tenders/${tenderId}/junta-questions`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].id).toBe(body.id);
  });

  it('sin conflictos ni ambigüedades no genera ninguna pregunta -- nunca fabrica una pregunta de la nada', async () => {
    const owner = await registerAndLogin(app, 'jq-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'JQ Org 2', 'jq-org-2');
    const tenderId = await createTender(app, org.id, 'jq-002');

    const doc = toBase64('El licitante debera presentar la fianza de cumplimiento conforme a la clausula 5.');
    const upload = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/documents`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentKind: 'bases', filename: 'bases.txt', mimeType: 'text/plain', contentBase64: doc },
    });
    expect(upload.statusCode).toBe(201);

    const generate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/junta-questions/generate`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { juntaAclaracionesAt: '2026-09-25T10:00:00-06:00' },
    });
    expect(generate.statusCode).toBe(201);
    expect(generate.json().questions).toHaveLength(0);
  });

  it('rechaza una fecha de junta sin offset horario explícito con 400 (nunca calcula una ventana ambigua)', async () => {
    const owner = await registerAndLogin(app, 'jq-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'JQ Org 3', 'jq-org-3');
    const tenderId = await createTender(app, org.id, 'jq-003');

    const generate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/junta-questions/generate`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { juntaAclaracionesAt: '2026-09-25T10:00:00' }, // sin offset
    });
    expect(generate.statusCode).toBe(422);
  });

  it('un rol de solo lectura (viewer) no puede generar preguntas de junta, pero sí puede listarlas', async () => {
    const owner = await registerAndLogin(app, 'jq-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'JQ Org 4', 'jq-org-4');
    const tenderId = await createTender(app, org.id, 'jq-004');
    const viewer = await registerAndLogin(app, 'jq-viewer-4@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const generateAsViewer = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/junta-questions/generate`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { juntaAclaracionesAt: '2026-09-25T10:00:00-06:00' },
    });
    expect(generateAsViewer.statusCode).toBe(403);

    const listAsViewer = await app.inject({
      method: 'GET',
      url: `/expediente/tenders/${tenderId}/junta-questions`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
    });
    expect(listAsViewer.statusCode).toBe(200);
    expect(listAsViewer.json()).toEqual([]);
  });

  it('aislamiento entre organizaciones: una org ajena no puede ver ni generar preguntas de junta de un tender que no es suyo', async () => {
    const ownerA = await registerAndLogin(app, 'jq-owner-5a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'JQ Org 5A', 'jq-org-5a');
    const tenderId = await createTender(app, orgA.id, 'jq-005');

    const ownerB = await registerAndLogin(app, 'jq-owner-5b@example.com');
    const orgB = await createOrgFor(app, ownerB, 'JQ Org 5B', 'jq-org-5b');

    const generateCrossOrg = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/junta-questions/generate`,
      headers: { authorization: `Bearer ${ownerB.accessToken}`, 'x-org-id': orgB.id },
      payload: { juntaAclaracionesAt: '2026-09-25T10:00:00-06:00' },
    });
    expect(generateCrossOrg.statusCode).toBe(404);

    const listCrossOrg = await app.inject({
      method: 'GET',
      url: `/expediente/tenders/${tenderId}/junta-questions`,
      headers: { authorization: `Bearer ${ownerB.accessToken}`, 'x-org-id': orgB.id },
    });
    expect(listCrossOrg.statusCode).toBe(404);
  });
});
