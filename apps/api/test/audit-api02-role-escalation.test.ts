import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp, registerAndLogin, createOrgFor } from './helpers.js';

/**
 * Reproduce y verifica el cierre de API-02 (docs/auditoria-1/db-api.md,
 * ALTA): PATCH /organizations/memberships/:userId permitía que un `admin`
 * se autopromoviera a `owner`, y que degradara al único `owner` de la
 * organización dejándola sin ningún owner activo.
 */
describe('API-02: escalada de rol y protección del último owner', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('un admin NO puede autopromoverse (ni promover a otro) a owner', async () => {
    const owner = await registerAndLogin(app, 'api02-owner@example.com');
    const admin = await registerAndLogin(app, 'api02-admin@example.com');
    const org = await createOrgFor(app, owner, 'API02 Org', 'api02-org-1');

    // owner nombra admin a `admin`.
    const invite = await app.inject({
      method: 'PATCH',
      url: `/organizations/memberships/${admin.id}`,
      headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
      payload: { role: 'admin' },
    });
    // El admin aún no es miembro: se necesita crear la membresía primero
    // (invitación+aceptación está fuera del alcance de este test), así que
    // se inserta directamente para centrar el test en la escalada de rol.
    if (invite.statusCode !== 200) {
      await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'admin')", [org.id, admin.id]);
    }

    // admin intenta autopromoverse a owner.
    const selfPromote = await app.inject({
      method: 'PATCH',
      url: `/organizations/memberships/${admin.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}`, 'x-org-id': org.id },
      payload: { role: 'owner' },
    });
    expect(selfPromote.statusCode).toBe(403);

    const membership = await db.query<{ role: string }>('select role from memberships where org_id = $1 and user_id = $2', [
      org.id,
      admin.id,
    ]);
    expect(membership.rows[0].role).toBe('admin');
  });

  it('un admin NO puede degradar al único owner de la organización, dejándola sin owners', async () => {
    const owner = await registerAndLogin(app, 'api02-owner2@example.com');
    const admin = await registerAndLogin(app, 'api02-admin2@example.com');
    const org = await createOrgFor(app, owner, 'API02 Org 2', 'api02-org-2');
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'admin')", [org.id, admin.id]);

    const degrade = await app.inject({
      method: 'PATCH',
      url: `/organizations/memberships/${owner.id}`,
      headers: { authorization: `Bearer ${admin.accessToken}`, 'x-org-id': org.id },
      payload: { role: 'viewer' },
    });
    expect(degrade.statusCode).toBe(409);

    const owners = await db.query<{ count: string }>(
      "select count(*)::text as count from memberships where org_id = $1 and role = 'owner' and status = 'active'",
      [org.id]
    );
    expect(Number(owners.rows[0].count)).toBeGreaterThan(0);
  });

  it('un owner SÍ puede promover a otro miembro a owner', async () => {
    // App/DB propias para este caso: los 2 tests anteriores ya consumen
    // varios intentos del rate limit de /auth/login (5/min por IP) sobre la
    // app compartida del `beforeAll`; aislar este caso evita un 429 que no
    // tiene relación con lo que se está probando aquí.
    const { app: freshApp, db: freshDb } = await createTestApp();
    try {
      const owner = await registerAndLogin(freshApp, 'api02-owner3@example.com');
      const other = await registerAndLogin(freshApp, 'api02-other3@example.com');
      const org = await createOrgFor(freshApp, owner, 'API02 Org 3', 'api02-org-3');
      await freshDb.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [org.id, other.id]);

      const promote = await freshApp.inject({
        method: 'PATCH',
        url: `/organizations/memberships/${other.id}`,
        headers: { authorization: `Bearer ${owner.accessToken}`, 'x-org-id': org.id },
        payload: { role: 'owner' },
      });
      expect(promote.statusCode).toBe(200);
    } finally {
      await freshApp.close();
      await freshDb.close();
    }
  });
});
