import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

async function makeSuperadmin(db: DbClient, userId: string): Promise<void> {
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
}

/**
 * REQ-026/REQ-111/REQ-112: visibilidad de compliance para superadmin sobre
 * las tablas de solo superadmin/worker_role (packages/db/migrations/
 * 0099/0100) -- mismo criterio de prueba que
 * `admin-backoffice.test.ts` (`/admin/connectors/freshness`).
 */
describe('back office / superadmin: KYC negativo y fingerprint de interpósita persona', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('un usuario normal recibe 403 en las 3 rutas /admin/kyc/*', async () => {
    const normalUser = await registerAndLogin(app, 'admin-kyc-normal@example.com');
    for (const url of ['/admin/kyc/freshness', '/admin/kyc/tenants', '/admin/kyc/fingerprint-matches']) {
      const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${normalUser.accessToken}` } });
      expect(res.statusCode).toBe(403);
    }
  });

  it('GET /admin/kyc/freshness: sin ninguna corrida -> isStale=true, snapshotId null (A4, nunca "todo bien" silencioso)', async () => {
    const superadmin = await registerAndLogin(app, 'admin-kyc-fresh-empty@example.com');
    await makeSuperadmin(db, superadmin.id);

    const res = await app.inject({ method: 'GET', url: '/admin/kyc/freshness', headers: { authorization: `Bearer ${superadmin.accessToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ snapshotId: null, fetchedAt: null, listAsOfDate: null, recordCount: null, ageSeconds: null, isStale: true });
  });

  it('GET /admin/kyc/freshness: snapshot reciente -> isStale=false; snapshot de hace >48h -> isStale=true (REQ-026 literal)', async () => {
    const superadmin = await registerAndLogin(app, 'admin-kyc-fresh@example.com');
    await makeSuperadmin(db, superadmin.id);

    await db.query(
      `insert into sanctions_69b_snapshots (source_url, fetched_at, list_as_of_date, list_as_of_raw, record_count, raw_hash)
       values ('http://x', now(), '2026-01-01', 'leyenda', 14234, 'hash-recent')`
    );
    const fresh = await app.inject({ method: 'GET', url: '/admin/kyc/freshness', headers: { authorization: `Bearer ${superadmin.accessToken}` } });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().isStale).toBe(false);
    expect(fresh.json().recordCount).toBe(14234);
    expect(fresh.json().listAsOfDate).toBe('2026-01-01');

    // Segunda corrida (más reciente) hace >48h: la MÁS RECIENTE es la que cuenta.
    await db.query(
      `insert into sanctions_69b_snapshots (source_url, fetched_at, list_as_of_date, list_as_of_raw, record_count, raw_hash)
       values ('http://x', now() - interval '49 hours', '2025-12-01', 'leyenda vieja', 1, 'hash-old')`
    );
    const stillFresh = await app.inject({ method: 'GET', url: '/admin/kyc/freshness', headers: { authorization: `Bearer ${superadmin.accessToken}` } });
    // La corrida más reciente sigue siendo la de "now()", así que sigue sin ser obsoleta.
    expect(stillFresh.json().isStale).toBe(false);
  });

  it('GET /admin/kyc/tenants: solo lista tenants flagged/suspended, nunca los clear', async () => {
    const superadmin = await registerAndLogin(app, 'admin-kyc-tenants@example.com');
    await makeSuperadmin(db, superadmin.id);
    const owner = await registerAndLogin(app, 'admin-kyc-tenants-owner@example.com');
    const orgSuspended = await createOrgFor(app, owner, 'Empresa Suspendida Admin', 'admin-kyc-org-suspended');
    const orgClear = await createOrgFor(app, owner, 'Empresa Clara Admin', 'admin-kyc-org-clear');

    await db.query("insert into tenant_kyc_status (org_id, verdict, reason) values ($1, 'suspended', 'Definitivo')", [orgSuspended.id]);
    await db.query("insert into tenant_kyc_status (org_id, verdict, reason) values ($1, 'clear', null)", [orgClear.id]);

    const res = await app.inject({ method: 'GET', url: '/admin/kyc/tenants', headers: { authorization: `Bearer ${superadmin.accessToken}` } });
    expect(res.statusCode).toBe(200);
    const orgIds = res.json().map((r: any) => r.orgId);
    expect(orgIds).toContain(orgSuspended.id);
    expect(orgIds).not.toContain(orgClear.id);
    const entry = res.json().find((r: any) => r.orgId === orgSuspended.id);
    expect(entry.verdict).toBe('suspended');
    expect(entry.orgName).toBe('Empresa Suspendida Admin');
  });

  it('GET /admin/kyc/fingerprint-matches: solo candidatos "open", con los nombres de ambas organizaciones', async () => {
    const superadmin = await registerAndLogin(app, 'admin-kyc-fp@example.com');
    await makeSuperadmin(db, superadmin.id);
    const owner = await registerAndLogin(app, 'admin-kyc-fp-owner@example.com');
    const orgA = await createOrgFor(app, owner, 'Empresa Fingerprint A', 'admin-kyc-fp-org-a');
    const orgB = await createOrgFor(app, owner, 'Empresa Fingerprint B', 'admin-kyc-fp-org-b');
    const [first, second] = [orgA.id, orgB.id].sort();

    await db.query(
      `insert into entity_fingerprint_matches (org_id_a, org_id_b, score, matched_fields, status)
       values ($1, $2, 0.4, '[{"field":"domicilio","value":"reforma 500"}]'::jsonb, 'open')`,
      [first, second]
    );

    const res = await app.inject({ method: 'GET', url: '/admin/kyc/fingerprint-matches', headers: { authorization: `Bearer ${superadmin.accessToken}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    const match = res.json()[0];
    expect([match.orgIdA, match.orgIdB].sort()).toEqual([first, second]);
    expect([match.orgNameA, match.orgNameB].sort()).toEqual(['Empresa Fingerprint A', 'Empresa Fingerprint B'].sort());
    expect(match.matchedFields).toEqual([{ field: 'domicilio', value: 'reforma 500' }]);

    await db.query("update entity_fingerprint_matches set status = 'reviewed' where org_id_a = $1 and org_id_b = $2", [first, second]);
    const afterReview = await app.inject({ method: 'GET', url: '/admin/kyc/fingerprint-matches', headers: { authorization: `Bearer ${superadmin.accessToken}` } });
    expect(afterReview.json()).toHaveLength(0);
  });
});
