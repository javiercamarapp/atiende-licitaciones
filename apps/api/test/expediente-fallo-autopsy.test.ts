import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * REQ-054 — autopsia del fallo: informe estructurado comparando la
 * propuesta propia vs. el fallo (motivos de desechamiento, puntos/
 * criterios, precio vs. ganador si es público), lecciones registradas y
 * vinculadas al perfil de empresa, sin inventar datos ausentes ->
 * "no disponible".
 */

async function createTender(app: FastifyInstance, orgId: string, externalId = 'c054-001'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: { records: [{ source: 'compras-mx', externalId, title: 'Licitación perdida', sourceVersion: 'v1' }], organizationIds: [orgId] },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('expediente — autopsia del fallo (REQ-054)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('registra la comparación completa (precio/puntos propios vs. ganador) y vincula lecciones al perfil de empresa', async () => {
    const owner = await registerAndLogin(app, 'c054-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'C054 Org 1', 'c054-org-1');
    const tenderId = await createTender(app, org.id);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/fallo-autopsy`,
      headers,
      payload: {
        ownProposalStatus: 'desechada',
        disqualificationReason: 'No se presentó la carta de fabricante requerida.',
        ownScore: 82,
        winnerScore: 95,
        ownPrice: 1200000,
        winnerPrice: 1150000,
        winnerName: 'Proveedor Ganador SA de CV',
        criteriaComparison: [{ criterio: 'Experiencia', propio: '5 contratos similares', ganador: '12 contratos similares' }],
        lessons: ['Confirmar checklist de anexos obligatorios antes de enviar la propuesta.', 'Revisar cartas de fabricante con 5 días de anticipación.'],
      },
    });
    expect(create.statusCode).toBe(201);
    const autopsy = create.json();
    expect(autopsy.disqualificationReason).toBe('No se presentó la carta de fabricante requerida.');
    expect(autopsy.winnerName).toBe('Proveedor Ganador SA de CV');
    expect(autopsy.ownPrice).toBe(1200000);
    expect(autopsy.winnerPrice).toBe(1150000);
    expect(autopsy.lessons.length).toBe(2);
    expect(autopsy.linkedToCompanyProfile).toBe(true);

    const lessons = await app.inject({ method: 'GET', url: '/expediente/lessons-learned', headers });
    expect(lessons.statusCode).toBe(200);
    expect(lessons.json().length).toBe(2);
    expect(lessons.json()[0].tenderId).toBe(tenderId);
  });

  it('sin datos de fallo público (precio/puntos del ganador), los campos ausentes se registran explícitamente como "no disponible", nunca inventados', async () => {
    const owner = await registerAndLogin(app, 'c054-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'C054 Org 2', 'c054-org-2');
    const tenderId = await createTender(app, org.id, 'c054-002');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/fallo-autopsy`,
      headers,
      payload: { lessons: ['Registrar el fallo completo la próxima vez.'] },
    });
    expect(create.statusCode).toBe(201);
    const autopsy = create.json();
    expect(autopsy.disqualificationReason).toBe('no disponible');
    expect(autopsy.winnerName).toBe('no disponible');
    expect(autopsy.ownPrice).toBeNull();
    expect(autopsy.winnerPrice).toBeNull();
    expect(autopsy.ownProposalStatus).toBe('desconocido');
    expect(autopsy.criteriaComparison).toEqual([]);
  });

  it('lessons vacío es rechazado (422): siempre debe registrarse al menos una lección', async () => {
    const owner = await registerAndLogin(app, 'c054-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'C054 Org 3', 'c054-org-3');
    const tenderId = await createTender(app, org.id, 'c054-003');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const create = await app.inject({ method: 'POST', url: `/expediente/tenders/${tenderId}/fallo-autopsy`, headers, payload: { lessons: [] } });
    expect(create.statusCode).toBe(422);
  });

  it('viewer no puede registrar una autopsia del fallo', async () => {
    const owner = await registerAndLogin(app, 'c054-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'C054 Org 4', 'c054-org-4');
    const tenderId = await createTender(app, org.id, 'c054-004');
    const viewer = await registerAndLogin(app, 'c054-viewer-4@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const attempt = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/fallo-autopsy`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { lessons: ['algo'] },
    });
    expect(attempt.statusCode).toBe(403);
  });
});
