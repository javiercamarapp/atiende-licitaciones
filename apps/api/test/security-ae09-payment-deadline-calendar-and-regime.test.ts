import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * AE-09 (docs/auditoria-2/api-expediente.md, MEDIA): el cálculo del plazo
 * de pago (`POST /post-award`, kind="pago") nunca advertía en la RESPUESTA
 * de la API que el calendario de días hábiles usado es incompleto (solo
 * excluye sábado/domingo) -- la advertencia solo existía en comentarios de
 * código y README. Tampoco versionaba el régimen legal aplicable según la
 * fecha de la convocatoria (REQ-050): siempre aplicaba la ley nueva (17
 * días hábiles), incluso para convocatorias anteriores al 17-abr-2025
 * (vigor de la reforma), que deberían regirse por la ley abrogada (20 días
 * naturales, LAASSP 2000 Art. 51).
 *
 * Fijado: `computePaymentDeadline` ahora recibe la fecha de publicación de
 * la convocatoria y devuelve `calendarNote`/`legalRegime`, expuestos en la
 * respuesta de `POST/GET /post-award`.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId: string, publishedAt?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: {
      records: [{ source: 'compras-mx', externalId, title: 'Contrato AE-09', sourceVersion: 'v1', ...(publishedAt ? { publishedAt } : {}) }],
      organizationIds: [orgId],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('AE-09: calendarNote y legalRegime (REQ-050) en el plazo de pago', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('convocatoria publicada bajo la ley nueva (>= 2025-04-17): 17 días hábiles, Art. 73, calendarNote explícito', async () => {
    const owner = await registerAndLogin(app, 'ae09-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'AE09 Org 1', 'ae09-org-1');
    const tenderId = await createTender(app, org.id, 'ae09-001', '2025-05-01T00:00:00Z');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'pago', label: 'Pago factura 1', invoiceVerifiedOn: '2026-01-05' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.calendarNote).toBe('solo excluye sábados y domingos; días inhábiles oficiales pendientes');
    expect(body.legalRegime.law).toBe('LAASSP nueva');
    expect(body.legalRegime.article).toBe('Art. 73');
    expect(body.legalRegime.unit).toBe('dias_habiles');
    expect(body.legalRegime.days).toBe(17);
  });

  it('convocatoria publicada ANTES de la reforma (< 2025-04-17): 20 días naturales, Art. 51 (régimen abrogado)', async () => {
    const owner = await registerAndLogin(app, 'ae09-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'AE09 Org 2', 'ae09-org-2');
    const tenderId = await createTender(app, org.id, 'ae09-002', '2024-06-01T00:00:00Z');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'pago', label: 'Pago factura 2', invoiceVerifiedOn: '2024-08-01' },
    });
    expect(create.statusCode).toBe(201);
    const body = create.json();
    expect(body.legalRegime.law).toBe('LAASSP 2000 (abrogada)');
    expect(body.legalRegime.article).toBe('Art. 51');
    expect(body.legalRegime.unit).toBe('dias_naturales');
    expect(body.legalRegime.days).toBe(20);
    // 20 días NATURALES desde 2024-08-01 -> 2024-08-21 (sin excluir fines de semana).
    expect(String(body.dueDate).slice(0, 10)).toBe('2024-08-21');
  });

  it('sin fecha de convocatoria conocida, usa por defecto el régimen vigente (ley nueva), nunca la ley abrogada sin evidencia', async () => {
    const owner = await registerAndLogin(app, 'ae09-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'AE09 Org 3', 'ae09-org-3');
    const tenderId = await createTender(app, org.id, 'ae09-003'); // sin publishedAt
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'pago', label: 'Pago factura 3', invoiceVerifiedOn: '2026-01-05' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().legalRegime.unit).toBe('dias_habiles');
  });

  it('un hito genérico (kind != "pago") no incluye calendarNote/legalRegime (null)', async () => {
    const owner = await registerAndLogin(app, 'ae09-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'AE09 Org 4', 'ae09-org-4');
    const tenderId = await createTender(app, org.id, 'ae09-004');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const create = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/post-award`,
      headers,
      payload: { kind: 'hito', label: 'Hito genérico' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().calendarNote).toBeNull();
    expect(create.json().legalRegime).toBeNull();
  });
});
