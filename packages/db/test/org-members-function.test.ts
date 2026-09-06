import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedSuperadmin, asActor } from './helpers.js';

/**
 * Ronda 4 (docs/logs/api-ronda4.log, item 2): `app.org_members(p_org_id)`
 * (migración 0052) -- lista miembros con email/nombre resolviendo la RLS de
 * `users` (que por sí sola solo deja ver la propia fila) desde una función
 * SECURITY DEFINER que verifica DENTRO que el llamador es miembro activo de
 * esa organización (cualquier rol) o superadmin -- nunca confía en
 * `p_org_id` sin relación con el llamador (mismo espíritu que DB-01/DB-12).
 */
describe('app.org_members (ronda 4)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('un miembro activo (cualquier rol) ve email/nombre/rol de los demás miembros de SU organización', async () => {
    const org = await seedOrg(db, 'org-members-a');
    const ownerId = await seedMember(db, org.orgId, 'owner-a@example.com', 'owner');
    const viewerId = await seedMember(db, org.orgId, 'viewer-a@example.com', 'viewer');

    const rows = await asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
      tx.query('select * from app.org_members($1) order by joined_at asc', [org.orgId])
    );
    expect(rows.rows.length).toBe(2);
    const emails = (rows.rows as any[]).map((r) => r.email).sort();
    expect(emails).toEqual(['owner-a@example.com', 'viewer-a@example.com'].sort());
    const ownerRow = (rows.rows as any[]).find((r) => r.user_id === ownerId);
    expect(ownerRow.role).toBe('owner');
  });

  it('un OUTSIDER (sin membresía en esa organización) NO puede leer sus miembros -- la función lanza, ninguna fila se filtra', async () => {
    const orgA = await seedOrg(db, 'org-members-b');
    await seedMember(db, orgA.orgId, 'member-b@example.com', 'owner');

    const orgB = await seedOrg(db, 'org-members-c');
    const outsiderId = await seedMember(db, orgB.orgId, 'outsider-b@example.com', 'owner');

    await expect(
      asActor(db, { orgId: orgB.orgId, userId: outsiderId }, (tx) => tx.query('select * from app.org_members($1)', [orgA.orgId]))
    ).rejects.toThrow(/org_members_forbidden/);
  });

  it('un superadmin puede leer los miembros de CUALQUIER organización, sea o no miembro', async () => {
    const org = await seedOrg(db, 'org-members-d');
    await seedMember(db, org.orgId, 'member-d@example.com', 'owner');
    const superadminId = await seedSuperadmin(db, 'superadmin-d@example.com');

    const rows = await asActor(db, { userId: superadminId }, (tx) => tx.query('select * from app.org_members($1)', [org.orgId]));
    expect(rows.rows.length).toBe(1);
  });
});
