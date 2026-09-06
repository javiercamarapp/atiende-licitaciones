import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor, enrollTwoFactor } from './helpers.js';

// Una app/DB por caso (ver nota en tenders-and-ingest.test.ts sobre el
// rate limit de /auth/login compartido dentro de una misma app).
describe('perfil de empresa (E2)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('PUT /company/profile (owner) crea el perfil con procedencia por campo; viewer no puede escribirlo', async () => {
    const owner = await registerAndLogin(app, 'company-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Company Org 1', 'company-org-1');
    const viewer = await registerAndLogin(app, 'company-viewer-1@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const put = await app.inject({
      method: 'PUT',
      url: '/company/profile',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { legalName: 'Constructora Ejemplo SA de CV', taxId: 'CEJ010101AAA' },
    });
    expect(put.statusCode).toBe(200);
    const profileId = put.json().id;

    const provenance = await app.inject({
      method: 'GET',
      url: '/company/profile/provenance',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(provenance.statusCode).toBe(200);
    const fields = provenance.json().map((p: any) => p.field);
    expect(fields).toContain('legalName');
    expect(provenance.json()[0].ownerUserId).toBe(owner.id);
    expect(provenance.json()[0].source).toBe('manual');

    const viewerAttempt = await app.inject({
      method: 'PUT',
      url: '/company/profile',
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { legalName: 'Intento de viewer' },
    });
    expect(viewerAttempt.statusCode).toBe(403);

    const stillOriginal = await db.query<{ legal_name: string }>('select legal_name from company_profiles where id = $1', [profileId]);
    expect(stillOriginal.rows[0].legal_name).toBe('Constructora Ejemplo SA de CV');
  });

  it('writer puede crear una capability (rol de escritura); viewer no puede', async () => {
    const owner = await registerAndLogin(app, 'company-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Company Org 2', 'company-org-2');
    const writer = await registerAndLogin(app, 'company-writer-2@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, writer.id]);
    const viewer = await registerAndLogin(app, 'company-viewer-2@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const created = await app.inject({
      method: 'POST',
      url: '/company/capabilities',
      headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id },
      payload: { name: 'Instalación de redes eléctricas' },
    });
    expect(created.statusCode).toBe(201);

    const viewerAttempt = await app.inject({
      method: 'POST',
      url: '/company/capabilities',
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { name: 'Intento de viewer' },
    });
    expect(viewerAttempt.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: '/company/capabilities',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(list.json().length).toBe(1);
  });

  it('experiencia sin evidenceRef queda marcada verifiable=false (REQ-143)', async () => {
    const owner = await registerAndLogin(app, 'company-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Company Org 3', 'company-org-3');

    const withoutEvidence = await app.inject({
      method: 'POST',
      url: '/company/experience',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { title: 'Contrato de mantenimiento vial' },
    });
    expect(withoutEvidence.json().verifiable).toBe(false);

    const withEvidence = await app.inject({
      method: 'POST',
      url: '/company/experience',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { title: 'Contrato de obra hidráulica', evidenceRef: 'company-docs/contrato-2024.pdf' },
    });
    expect(withEvidence.json().verifiable).toBe(true);
  });

  it('company_documents: documento vencido se refleja con status expired (REQ-023, A7)', async () => {
    const owner = await registerAndLogin(app, 'company-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'Company Org 4', 'company-org-4');
    const contentBase64 = Buffer.from('contenido de prueba del documento').toString('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/company/documents',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { documentType: 'opinion_32d', contentBase64, validUntil: '2020-01-01' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('expired');
    expect(res.json().fileHash).toMatch(/^[0-9a-f]{64}$/);

    const list = await app.inject({
      method: 'GET',
      url: '/company/documents',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(list.json()[0].status).toBe('expired');
  });

  it('A8: approved_rates -- writer propone (draft), solo owner/admin aprueban; tarifa no aprobada no es utilizable', async () => {
    const owner = await registerAndLogin(app, 'company-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'Company Org 5', 'company-org-5');
    const writer = await registerAndLogin(app, 'company-writer-5@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, writer.id]);
    const viewer = await registerAndLogin(app, 'company-viewer-5@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const viewerAttempt = await app.inject({
      method: 'POST',
      url: '/company/rates',
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
      payload: { itemCode: 'ITEM-1', description: 'Concreto hidráulico m3', unitPrice: 1500 },
    });
    expect(viewerAttempt.statusCode).toBe(403);

    const proposed = await app.inject({
      method: 'POST',
      url: '/company/rates',
      headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id },
      payload: { itemCode: 'ITEM-1', description: 'Concreto hidráulico m3', unitPrice: 1500 },
    });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json().status).toBe('draft');
    const rateId = proposed.json().id;

    // Writer NO puede aprobar su propia propuesta.
    const writerApprove = await app.inject({
      method: 'POST',
      url: `/company/rates/${rateId}/approve`,
      headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id },
    });
    expect(writerApprove.statusCode).toBe(403);

    // Pipeline de redacción (aquí: el enforcement de esquema en DB) rechaza
    // una tarifa "draft" al intentar usarla en una línea de propuesta.
    const tenderRes = await db.query<{ id: string }>(
      "insert into tenders (org_id, source, external_id, title) values ($1, 'test', 'a8-1', 'X') returning id",
      [org.id]
    );
    const proposalRes = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta A8') returning id",
      [org.id, tenderRes.rows[0].id]
    );
    await expect(
      db.query(
        `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
         values ($1, $2, $3, 1, 1500, 1500)`,
        [org.id, proposalRes.rows[0].id, rateId]
      )
    ).rejects.toThrow(/no está aprobada/);

    const { stepUpToken } = await enrollTwoFactor(app, owner.accessToken, { orgId: org.id, purpose: 'company.rate_approval' });
    const approved = await app.inject({
      method: 'POST',
      url: `/company/rates/${rateId}/approve`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id, 'x-step-up': stepUpToken },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json().status).toBe('approved');

    // Ahora sí puede usarse.
    const inserted = await db.query(
      `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
       values ($1, $2, $3, 1, 1500, 1500) returning id`,
      [org.id, proposalRes.rows[0].id, rateId]
    );
    expect(inserted.rows.length).toBe(1);
  });

  it('A5/aislamiento: capabilities de una organización no son visibles para otra', async () => {
    const ownerA = await registerAndLogin(app, 'company-owner-6a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'Company Org 6A', 'company-org-6a');
    const ownerB = await registerAndLogin(app, 'company-owner-6b@example.com');
    const orgB = await createOrgFor(app, ownerB, 'Company Org 6B', 'company-org-6b');

    await app.inject({
      method: 'POST',
      url: '/company/capabilities',
      headers: { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgA.id },
      payload: { name: 'Capacidad exclusiva de A' },
    });

    const listB = await app.inject({
      method: 'GET',
      url: '/company/capabilities',
      headers: { authorization: `Bearer ${ownerB.accessToken}`, 'x-org-id': orgB.id },
    });
    expect(listB.json().length).toBe(0);
  });
});
