import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * Ronda 4, item 2 (docs/logs/api-ronda4.log): apps/web (README) señaló que
 * apps/api no exponía ningún endpoint para LISTAR los miembros de una
 * organización. `GET /organizations/:orgId/memberships` (ver
 * `app.org_members`, packages/db/migrations/0052).
 */
describe('GET /organizations/:orgId/memberships (ronda 4)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('member+ (cualquier rol, incluido viewer) ve la lista de miembros con su rol real', async () => {
    const owner = await registerAndLogin(app, 'mem-owner-1@example.com');
    const org = await createOrgFor(app, owner, 'Mem Org 1', 'mem-org-1');

    const viewer = await registerAndLogin(app, 'mem-viewer-1@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'viewer')", [org.id, viewer.id]);

    const res = await app.inject({
      method: 'GET',
      url: `/organizations/${org.id}/memberships`,
      headers: { authorization: `Bearer ${viewer.accessToken}`, 'x-org-id': org.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items.length).toBe(2);
    const roles = body.items.map((m: any) => ({ email: m.email, role: m.role })).sort((a: any, b: any) => a.email.localeCompare(b.email));
    expect(roles).toEqual([
      { email: 'mem-owner-1@example.com', role: 'owner' },
      { email: 'mem-viewer-1@example.com', role: 'viewer' },
    ]);
  });

  it('un usuario SIN membresía en esa organización recibe 403 (RLS + app.requireOrg)', async () => {
    const owner = await registerAndLogin(app, 'mem-owner-2@example.com');
    const org = await createOrgFor(app, owner, 'Mem Org 2', 'mem-org-2');
    const outsider = await registerAndLogin(app, 'mem-outsider-2@example.com');

    const res = await app.inject({
      method: 'GET',
      url: `/organizations/${org.id}/memberships`,
      headers: { authorization: `Bearer ${outsider.accessToken}`, 'x-org-id': org.id },
    });
    expect(res.statusCode).toBe(403);
  });

  it('cross-org: no filtra miembros de OTRA organización aunque el :orgId de la URL sea distinto de X-Org-Id', async () => {
    const owner1 = await registerAndLogin(app, 'mem-owner-3a@example.com');
    const org1 = await createOrgFor(app, owner1, 'Mem Org 3A', 'mem-org-3a');
    const owner2 = await registerAndLogin(app, 'mem-owner-3b@example.com');
    const org2 = await createOrgFor(app, owner2, 'Mem Org 3B', 'mem-org-3b');

    // owner1 pide los miembros de org2 en la URL, pero autentica con
    // X-Org-Id de org1 (la única en la que sí es miembro real).
    const res = await app.inject({
      method: 'GET',
      url: `/organizations/${org2.id}/memberships`,
      headers: { authorization: `Bearer ${owner1.accessToken}`, 'x-org-id': org1.id },
    });
    expect(res.statusCode).toBe(403);
  });

  it('paginado: limit=1 devuelve nextCursor y la segunda página completa la lista sin duplicados', async () => {
    const owner = await registerAndLogin(app, 'mem-owner-4@example.com');
    const org = await createOrgFor(app, owner, 'Mem Org 4', 'mem-org-4');
    const second = await registerAndLogin(app, 'mem-second-4@example.com');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, second.id]);
    const headers = { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id };

    const page1 = await app.inject({ method: 'GET', url: `/organizations/${org.id}/memberships?limit=1`, headers });
    expect(page1.statusCode).toBe(200);
    expect(page1.json().items.length).toBe(1);
    expect(page1.json().nextCursor).not.toBeNull();

    const page2 = await app.inject({
      method: 'GET',
      url: `/organizations/${org.id}/memberships?limit=1&cursor=${encodeURIComponent(page1.json().nextCursor)}`,
      headers,
    });
    expect(page2.statusCode).toBe(200);
    expect(page2.json().items.length).toBe(1);
    expect(page2.json().nextCursor).toBeNull();

    const allEmails = [...page1.json().items, ...page2.json().items].map((m: any) => m.email).sort();
    expect(allEmails).toEqual(['mem-owner-4@example.com', 'mem-second-4@example.com'].sort());
  });
});
