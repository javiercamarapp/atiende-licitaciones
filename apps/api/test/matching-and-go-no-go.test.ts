import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

async function seedTenderDirect(
  db: DbClient,
  orgId: string,
  externalId: string,
  opts: { title?: string; budgetAmount?: number; cpvCodes?: string[] } = {}
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into tenders (id, org_id, source, external_id, title, budget_amount, cpv_codes)
     values ($1, $2, 'test', $3, $4, $5, $6)`,
    [id, orgId, externalId, opts.title ?? 'Convocatoria de prueba', opts.budgetAmount ?? null, opts.cpvCodes ?? []]
  );
  return id;
}

describe('matching y go/no-go (E5)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('sin perfil de empresa capturado, el matching marca campos faltantes y elegibilidad no_evaluable (REQ-166)', async () => {
    const owner = await registerAndLogin(app, 'match-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Match Org 1', 'match-org-1');
    const tenderId = await seedTenderDirect(db, org.id, 'match-ext-1');

    const res = await app.inject({
      method: 'GET',
      url: `/matching/tenders/${tenderId}`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.missingProfileFields).toEqual(expect.arrayContaining(['capabilities_or_products', 'locations']));
    // REQ-168: relevancia y elegibilidad son valores SEPARADOS, no un score único.
    expect(body).toHaveProperty('relevance.score');
    expect(body).toHaveProperty('eligibility.status');
    // Sin ningún registro capturado -> no_evaluable, nunca "cumple" inventado.
    expect(body.eligibility.status).toBe('no_evaluable');
  });

  it('un documento vencido produce elegibilidad no_cumple con evidencia (REQ-023, A7)', async () => {
    const owner = await registerAndLogin(app, 'match-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Match Org 2', 'match-org-2');
    const tenderId = await seedTenderDirect(db, org.id, 'match-ext-2');

    await db.query("insert into registrations (org_id, kind, value) values ($1, 'RFC', 'XAXX010101000')", [org.id]);
    await db.query(
      "insert into company_documents (org_id, document_type, storage_ref, valid_until) values ($1, 'opinion_32d', 'ref', current_date - interval '10 days')",
      [org.id]
    );

    const res = await app.inject({
      method: 'GET',
      url: `/matching/tenders/${tenderId}`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.eligibility.status).toBe('no_cumple');
    const docCriterion = body.eligibility.criteria.find((c: any) => c.requirement === 'documents_validity');
    expect(docCriterion.status).toBe('no_cumple');
  });

  it('writer NO puede decidir go/no-go (403); reviewer y owner sí pueden (E5, "writer nunca decide")', async () => {
    const owner = await registerAndLogin(app, 'gng-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'GNG Org 1', 'gng-org-1');
    const tenderId = await seedTenderDirect(db, org.id, 'gng-ext-1');

    const writer = await registerAndLogin(app, 'gng-writer-1@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, writer.id]);

    const reviewer = await registerAndLogin(app, 'gng-reviewer-1@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'reviewer')", [org.id, reviewer.id]);

    const writerAttempt = await app.inject({
      method: 'POST',
      url: `/tenders/${tenderId}/go-no-go`,
      headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id },
      payload: { decision: 'go', reasons: ['Buen ajuste'] },
    });
    expect(writerAttempt.statusCode).toBe(403);

    const reviewerAttempt = await app.inject({
      method: 'POST',
      url: `/tenders/${tenderId}/go-no-go`,
      headers: { authorization: `Bearer ${reviewer.accessToken}`, 'x-org-id': org.id },
      payload: { decision: 'go', reasons: ['Cumple requisitos duros'] },
    });
    expect(reviewerAttempt.statusCode).toBe(201);
    expect(reviewerAttempt.json().decidedBy).toBe(reviewer.id);

    const history = await app.inject({
      method: 'GET',
      url: `/tenders/${tenderId}/go-no-go`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(history.json().length).toBe(1);
  });

  it('A5: dos organizaciones con perfiles distintos no filtran datos entre sí en matching', async () => {
    // App/DB propias: este archivo ya hace varios logins sobre la app
    // compartida del beforeAll y el rate limit de /auth/login es 5/min por IP.
    const { app: freshApp, db: freshDb } = await createTestApp();
    try {
      const ownerA = await registerAndLogin(freshApp, 'gng-owner-a5-a@example.com');
      const orgA = await createOrgFor(freshApp, ownerA, 'A5 Org A', 'a5-org-a');
      const ownerB = await registerAndLogin(freshApp, 'gng-owner-a5-b@example.com');
      const orgB = await createOrgFor(freshApp, ownerB, 'A5 Org B', 'a5-org-b');

      await freshDb.query("insert into capabilities (org_id, name) values ($1, 'Construcción de carreteras')", [orgA.id]);
      await freshDb.query("insert into locations (org_id, label, state) values ($1, 'Sede', 'Jalisco')", [orgA.id]);

      await freshDb.query("insert into capabilities (org_id, name) values ($1, 'Servicios de limpieza')", [orgB.id]);
      await freshDb.query("insert into locations (org_id, label, state) values ($1, 'Sede', 'Sonora')", [orgB.id]);

      const tenderA = await seedTenderDirect(freshDb, orgA.id, 'a5-ext-a', { title: 'Construcción de carreteras rurales' });
      const tenderB = await seedTenderDirect(freshDb, orgB.id, 'a5-ext-b', { title: 'Servicios de limpieza de oficinas' });

      const resA = await freshApp.inject({
        method: 'GET',
        url: `/matching/tenders/${tenderA}`,
        headers: { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgA.id },
      });
      const resB = await freshApp.inject({
        method: 'GET',
        url: `/matching/tenders/${tenderB}`,
        headers: { authorization: `Bearer ${ownerB.accessToken}`, 'x-org-id': orgB.id },
      });
      expect(resA.statusCode).toBe(200);
      expect(resB.statusCode).toBe(200);

      // orgA no puede ver el tender de orgB vía matching (cross-org 404).
      const crossAttempt = await freshApp.inject({
        method: 'GET',
        url: `/matching/tenders/${tenderB}`,
        headers: { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgA.id },
      });
      expect(crossAttempt.statusCode).toBe(404);
    } finally {
      await freshApp.close();
      await freshDb.close();
    }
  });
});
