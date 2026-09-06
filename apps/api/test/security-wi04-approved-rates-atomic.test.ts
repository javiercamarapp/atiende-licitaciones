import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * WI-04 (docs/auditoria-2/web-integrado.md): `POST /company/rates/:id/approve|reject`
 * hacía un UPDATE incondicional (sin `WHERE status = 'draft'` alguno) --
 * aprobar (o rechazar) una tarifa ya decidida (aprobada o archivada)
 * simplemente la re-decidía en silencio, sin ningún error, y dos
 * aprobaciones concurrentes de la MISMA tarifa podían ambas responder 200
 * pisándose `approved_by`/`approved_at`. Mismo patrón que API-09 ya aplica
 * a `tool_calls`: el check (`status = 'draft'`) y la mutación son ahora LA
 * MISMA sentencia atómica (`UPDATE ... WHERE ... AND status = 'draft'
 * RETURNING`), con 409 explícito si ya estaba decidida.
 */
async function seedDraftRate(db: DbClient, orgId: string, itemCode: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into approved_rates (org_id, item_code, description, unit_price, status) values ($1, $2, 'desc', 100, 'draft') returning id",
    [orgId, itemCode]
  );
  return rows[0].id;
}

describe('WI-04: POST /company/rates/:id/approve|reject son transiciones de estado condicionales', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('dos aprobaciones concurrentes de la MISMA tarifa: exactamente una 200, la otra 409 -- nunca las dos 200', async () => {
    const owner = await registerAndLogin(app, 'wi04-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'WI04 Org 1', 'wi04-org-1');
    const rateId = await seedDraftRate(db, org.id, 'wi04-item-1');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const [first, second] = await Promise.all([
      app.inject({ method: 'POST', url: `/company/rates/${rateId}/approve`, headers }),
      app.inject({ method: 'POST', url: `/company/rates/${rateId}/approve`, headers }),
    ]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const row = await db.query<{ status: string }>('select status from approved_rates where id = $1', [rateId]);
    expect(row.rows[0].status).toBe('approved');

    // Un SOLO evento de auditoría para esta decisión, no dos.
    const audit = await db.query(
      "select count(*)::int as count from audit_log where entity = 'approved_rates' and action = 'approved_rate.approve' and entity_id = $1",
      [rateId]
    );
    expect(audit.rows[0].count).toBe(1);
  });

  it('aprobar una tarifa YA aprobada responde 409 (nunca re-decide en silencio)', async () => {
    const owner = await registerAndLogin(app, 'wi04-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'WI04 Org 2', 'wi04-org-2');
    const rateId = await seedDraftRate(db, org.id, 'wi04-item-2');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const first = await app.inject({ method: 'POST', url: `/company/rates/${rateId}/approve`, headers });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({ method: 'POST', url: `/company/rates/${rateId}/approve`, headers });
    expect(second.statusCode).toBe(409);
  });

  it('rechazar una tarifa YA aprobada responde 409 (reject solo aplica sobre draft)', async () => {
    const owner = await registerAndLogin(app, 'wi04-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'WI04 Org 3', 'wi04-org-3');
    const rateId = await seedDraftRate(db, org.id, 'wi04-item-3');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const approve = await app.inject({ method: 'POST', url: `/company/rates/${rateId}/approve`, headers });
    expect(approve.statusCode).toBe(200);

    const reject = await app.inject({ method: 'POST', url: `/company/rates/${rateId}/reject`, headers });
    expect(reject.statusCode).toBe(409);
  });

  it('approve y reject concurrentes de la MISMA tarifa draft: exactamente uno 200, el otro 409', async () => {
    const owner = await registerAndLogin(app, 'wi04-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'WI04 Org 4', 'wi04-org-4');
    const rateId = await seedDraftRate(db, org.id, 'wi04-item-4');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const [approve, reject] = await Promise.all([
      app.inject({ method: 'POST', url: `/company/rates/${rateId}/approve`, headers }),
      app.inject({ method: 'POST', url: `/company/rates/${rateId}/reject`, headers }),
    ]);
    const codes = [approve.statusCode, reject.statusCode].sort();
    expect(codes).toEqual([200, 409]);

    const row = await db.query<{ status: string }>('select status from approved_rates where id = $1', [rateId]);
    expect(['approved', 'archived']).toContain(row.rows[0].status);
  });
});
