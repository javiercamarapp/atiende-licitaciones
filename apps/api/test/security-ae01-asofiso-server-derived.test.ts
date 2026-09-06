import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor, TEST_PLATFORM_API_KEY } from './helpers.js';

/**
 * AE-01 (docs/auditoria-2/api-expediente.md, ALTA): la vigencia de una
 * tarifa/documento de empresa para el expediente se evaluaba contra
 * `asOfIso`, un campo controlado por el CLIENTE, en vez de contra
 * `tenders.submission_deadline` -- un `writer` podía generar una propuesta
 * económica con una tarifa vigente HOY pero que YA estará vencida a la
 * fecha real de presentación, simplemente enviando un `asOfIso` de "hoy".
 * Reabría, sin ninguna protección, el mismo patrón que DB-02/DB-10 ya
 * corrigen a nivel de Postgres (packages/db/migrations/0042, 0050) para
 * `proposal_pricing_lines` -- un flujo que el expediente nunca ejercita.
 *
 * Fijado: `lib/expediente/dates.ts` (`resolveExpedienteAsOfIso`) SIEMPRE
 * deriva la fecha de evaluación de `tenders.submission_deadline`; el
 * `asOfIso` del cuerpo de la petición se ignora por completo, y si el
 * tender no tiene `submission_deadline` fijado, se bloquea explícitamente
 * (422) en vez de usar "ahora" como aproximación.
 */

async function createTender(app: FastifyInstance, orgId: string, externalId: string, submissionDeadline?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/internal/tenders/ingest',
    headers: { 'x-platform-api-key': TEST_PLATFORM_API_KEY },
    payload: {
      records: [{ source: 'compras-mx', externalId, title: 'Servicio de prueba AE-01', sourceVersion: 'v1', ...(submissionDeadline ? { submissionDeadline } : {}) }],
      organizationIds: [orgId],
    },
  });
  expect(res.statusCode).toBe(200);
  return res.json().results[0].tenderId;
}

describe('AE-01: asOfIso NUNCA lo decide el cliente -- se deriva de tenders.submission_deadline', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('bloquea con 422 explícito ("fecha de presentación desconocida") si el tender no tiene submission_deadline', async () => {
    const owner = await registerAndLogin(app, 'ae01-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'AE01 Org 1', 'ae01-org-1');
    const tenderId = await createTender(app, org.id, 'ae01-001'); // sin submissionDeadline
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const technical = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/technical/generate`,
      headers,
      payload: { mappings: [] },
    });
    expect(technical.statusCode).toBe(422);
    expect(JSON.stringify(technical.json())).toMatch(/fecha de presentaci[oó]n desconocida|submission_deadline|submissionDeadline/i);

    const economic = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
      headers,
      payload: { lineItems: [{ concept: 'x', quantity: 1 }] },
    });
    expect(economic.statusCode).toBe(422);

    const checklist = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/checklist/run`,
      headers,
      payload: {},
    });
    expect(checklist.statusCode).toBe(422);
  });

  it('rechaza una tarifa vigente HOY pero vencida a la fecha de presentación, aunque el cliente envíe un asOfIso de "hoy" para intentar revivirla', async () => {
    const owner = await registerAndLogin(app, 'ae01-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'AE01 Org 2', 'ae01-org-2');
    // Presentación en 60 días.
    const submissionDeadline = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    const tenderId = await createTender(app, org.id, 'ae01-002', submissionDeadline);
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'company.rate_approval' });
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };

    // Tarifa vigente HOY (venció en 5 días desde ahora), pero para la fecha
    // de presentación (+60 días) ya estará vencida.
    const validFrom = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const validUntil = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rateRes = await app.inject({
      method: 'POST',
      url: '/company/rates',
      headers,
      payload: { itemCode: 'ae01-item', description: 'Tarifa que vence antes del acto', unitPrice: 100, validFrom, validUntil },
    });
    expect(rateRes.statusCode).toBe(201);
    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rateRes.json().id}/approve`, headers });
    expect(approve.statusCode).toBe(200);

    // El cliente intenta "revivir" la tarifa enviando un asOfIso de HOY
    // (momento en que la tarifa SÍ está vigente) -- debe ser ignorado.
    const generate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
      headers,
      payload: { lineItems: [{ concept: 'ae01-item', quantity: 1 }], asOfIso: new Date().toISOString() },
    });
    expect(generate.statusCode).toBe(200);
    expect(generate.json().economicTotals).toBeNull();
    expect(generate.json().generationReport.economic.blockedLineItems.length).toBe(1);
    expect(generate.json().generationReport.economic.blockedLineItems[0].concept).toBe('ae01-item');
  });

  it('acepta una tarifa vigente tanto hoy como a la fecha de presentación (no bloquea el caso correcto)', async () => {
    const owner = await registerAndLogin(app, 'ae01-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'AE01 Org 3', 'ae01-org-3');
    const submissionDeadline = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
    const tenderId = await createTender(app, org.id, 'ae01-003', submissionDeadline);
    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'company.rate_approval' });
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken };

    const validFrom = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const rateRes = await app.inject({
      method: 'POST',
      url: '/company/rates',
      headers,
      payload: { itemCode: 'ae01-ok-item', description: 'Tarifa vigente en ambas fechas', unitPrice: 100, validFrom, validUntil },
    });
    expect(rateRes.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: `/company/rates/${rateRes.json().id}/approve`, headers });

    const generate = await app.inject({
      method: 'POST',
      url: `/expediente/tenders/${tenderId}/proposal/economic/generate`,
      headers,
      payload: { lineItems: [{ concept: 'ae01-ok-item', quantity: 1 }] },
    });
    expect(generate.statusCode).toBe(200);
    expect(generate.json().economicTotals).not.toBeNull();
    expect(generate.json().generationReport.economic.blockedLineItems.length).toBe(0);
  });
});
