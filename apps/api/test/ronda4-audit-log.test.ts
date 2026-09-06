import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

async function makeSuperadmin(db: DbClient, userId: string): Promise<void> {
  await db.query('insert into platform_admins (user_id) values ($1)', [userId]);
}

/**
 * Ronda 4, item 2 (docs/logs/api-ronda4.log): `audit_log` existía (hash
 * encadenado, `app.verify_audit_log_chain()`) pero sin NINGÚN endpoint HTTP
 * de lectura. `GET /audit-log` (organización activa, reviewer/admin/owner)
 * y `GET /admin/audit-log` (superadmin, TODAS las organizaciones).
 */
describe('GET /audit-log (ronda 4)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('owner ve la bitácora real de su organización (al menos la creación de la org queda registrada)', async () => {
    const owner = await registerAndLogin(app, 'audit-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Audit Org 1', 'audit-org-1');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const res = await app.inject({ method: 'GET', url: '/audit-log', headers });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.some((e: any) => e.action === 'organization.create' && e.orgId === org.id)).toBe(true);
  });

  it('writer recibe 403 (solo reviewer/admin/owner leen la bitácora, más estricto que la RLS real)', async () => {
    const owner = await registerAndLogin(app, 'audit-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Audit Org 2', 'audit-org-2');
    const writer = await registerAndLogin(app, 'audit-writer-2@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, writer.id]);

    const res = await app.inject({
      method: 'GET',
      url: '/audit-log',
      headers: { authorization: `Bearer ${writer.accessToken}`, 'x-org-id': org.id },
    });
    expect(res.statusCode).toBe(403);
  });

  it('reviewer SÍ puede leer la bitácora', async () => {
    const owner = await registerAndLogin(app, 'audit-owner-3@example.com');
    const org = await createOrgFor(app, owner, 'Audit Org 3', 'audit-org-3');
    const reviewer = await registerAndLogin(app, 'audit-reviewer-3@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'reviewer')", [org.id, reviewer.id]);

    const res = await app.inject({
      method: 'GET',
      url: '/audit-log',
      headers: { authorization: `Bearer ${reviewer.accessToken}`, 'x-org-id': org.id },
    });
    expect(res.statusCode).toBe(200);
  });

  it('cross-org: NUNCA devuelve eventos de otra organización, ni con filtros', async () => {
    const ownerA = await registerAndLogin(app, 'audit-owner-4a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'Audit Org 4A', 'audit-org-4a');
    const ownerB = await registerAndLogin(app, 'audit-owner-4b@example.com');
    const orgB = await createOrgFor(app, ownerB, 'Audit Org 4B', 'audit-org-4b');

    const resA = await app.inject({
      method: 'GET',
      url: '/audit-log',
      headers: { authorization: `Bearer ${ownerA.accessToken}`, 'x-org-id': orgA.id },
    });
    expect(resA.statusCode).toBe(200);
    expect(resA.json().items.every((e: any) => e.orgId === orgA.id)).toBe(true);
    expect(resA.json().items.some((e: any) => e.orgId === orgB.id)).toBe(false);
  });

  it('filtro por entity funciona (solo devuelve entradas de esa entidad, todas de la propia org)', async () => {
    const owner = await registerAndLogin(app, 'audit-owner-5@example.com');
    const org = await createOrgFor(app, owner, 'Audit Org 5', 'audit-org-5');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    await app.inject({ method: 'POST', url: '/organizations/invitations', headers, payload: { email: 'invitado-5@example.com', role: 'viewer' } });

    const res = await app.inject({ method: 'GET', url: '/audit-log?entity=invitation', headers });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThan(0);
    expect(res.json().items.every((e: any) => e.entity === 'invitation')).toBe(true);
  });

  it('paginado por cursor: limit=1 no repite ni pierde entradas', async () => {
    const owner = await registerAndLogin(app, 'audit-owner-6@example.com');
    const org = await createOrgFor(app, owner, 'Audit Org 6', 'audit-org-6');
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };
    await app.inject({ method: 'POST', url: '/organizations/invitations', headers, payload: { email: 'invitado-6@example.com', role: 'viewer' } });

    const page1 = await app.inject({ method: 'GET', url: '/audit-log?limit=1', headers });
    expect(page1.json().items.length).toBe(1);
    expect(page1.json().nextCursor).not.toBeNull();

    const page2 = await app.inject({ method: 'GET', url: `/audit-log?limit=1&cursor=${encodeURIComponent(page1.json().nextCursor)}`, headers });
    expect(page2.statusCode).toBe(200);
    const ids1 = page1.json().items.map((e: any) => e.id);
    const ids2 = page2.json().items.map((e: any) => e.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);
  });

  it('un createdFrom inválido responde 400 explícito (nunca deja que Postgres reviente el casteo)', async () => {
    const owner = await registerAndLogin(app, 'audit-owner-7@example.com');
    const org = await createOrgFor(app, owner, 'Audit Org 7', 'audit-org-7');
    const res = await app.inject({
      method: 'GET',
      url: '/audit-log?createdFrom=no-es-una-fecha',
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /admin/audit-log (ronda 4, superadmin)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('un usuario normal recibe 403', async () => {
    const owner = await registerAndLogin(app, 'admin-audit-owner-1@example.com');
    await createOrgFor(app, owner, 'Admin Audit Org 1', 'admin-audit-org-1');
    const res = await app.inject({ method: 'GET', url: '/admin/audit-log', headers: { authorization: `Bearer ${owner.accessToken}` } });
    expect(res.statusCode).toBe(403);
  });

  it('un superadmin ve eventos de TODAS las organizaciones (nunca filtrados por tenant)', async () => {
    const ownerA = await registerAndLogin(app, 'admin-audit-owner-2a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'Admin Audit Org 2A', 'admin-audit-org-2a');
    const ownerB = await registerAndLogin(app, 'admin-audit-owner-2b@example.com');
    const orgB = await createOrgFor(app, ownerB, 'Admin Audit Org 2B', 'admin-audit-org-2b');
    await makeSuperadmin(db, ownerA.id);

    const res = await app.inject({ method: 'GET', url: '/admin/audit-log', headers: { authorization: `Bearer ${ownerA.accessToken}` } });
    expect(res.statusCode).toBe(200);
    const orgIds = res.json().items.map((e: any) => e.orgId);
    expect(orgIds).toContain(orgA.id);
    expect(orgIds).toContain(orgB.id);
  });

  it('filtro por orgId en /admin/audit-log acota a una sola organización', async () => {
    const ownerA = await registerAndLogin(app, 'admin-audit-owner-3a@example.com');
    const orgA = await createOrgFor(app, ownerA, 'Admin Audit Org 3A', 'admin-audit-org-3a');
    const ownerB = await registerAndLogin(app, 'admin-audit-owner-3b@example.com');
    await createOrgFor(app, ownerB, 'Admin Audit Org 3B', 'admin-audit-org-3b');
    await makeSuperadmin(db, ownerA.id);

    const res = await app.inject({
      method: 'GET',
      url: `/admin/audit-log?orgId=${orgA.id}`,
      headers: { authorization: `Bearer ${ownerA.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.every((e: any) => e.orgId === orgA.id)).toBe(true);
  });
});
