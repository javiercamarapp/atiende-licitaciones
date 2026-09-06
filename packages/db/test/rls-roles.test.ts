import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedSuperadmin, seedTender, asActor } from './helpers.js';

describe('RLS por rol', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('viewer no puede escribir (INSERT) en ninguna tabla de dominio representativa', async () => {
    const org = await seedOrg(db, 'org-viewer-write');
    const viewerId = await seedMember(db, org.orgId, 'viewer@example.com', 'viewer');
    const tenderId = await seedTender(db, org.orgId, 'ext-viewer-write');

    await expect(
      asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
        tx.query(
          "insert into tenders (org_id, source, external_id, title) values ($1, 'x', 'ext-viewer-2', 'x')",
          [org.orgId]
        )
      )
    ).rejects.toThrow(/row-level security/i);

    // Nota: para UPDATE/DELETE, la cláusula USING de RLS actúa como un
    // filtro silencioso (igual que un WHERE) en vez de lanzar una excepción:
    // Postgres simplemente no encuentra filas que el rol pueda actualizar,
    // así que el resultado correcto es rowCount 0, no una excepción. Solo
    // INSERT lanza (falla el WITH CHECK sobre la fila nueva).
    const viewerUpdate = await asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
      tx.query('update tenders set title = $1 where id = $2', ['hacked', tenderId])
    );
    expect(viewerUpdate.rowCount).toBe(0);
    const stillOriginal = await asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
      tx.query('select title from tenders where id = $1', [tenderId])
    );
    expect((stillOriginal.rows[0] as any).title).not.toBe('hacked');

    await expect(
      asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
        tx.query(
          "insert into proposals (org_id, tender_id, title) values ($1, $2, 'x')",
          [org.orgId, tenderId]
        )
      )
    ).rejects.toThrow(/row-level security/i);

    // Pero SÍ puede leer.
    const seen = await asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
      tx.query('select id from tenders where id = $1', [tenderId])
    );
    expect(seen.rows.length).toBe(1);
  });

  it('writer no puede aprobar (INSERT/UPDATE) decisiones go/no-go, pero sí puede escribir propuestas', async () => {
    const org = await seedOrg(db, 'org-writer-gng');
    const writerId = await seedMember(db, org.orgId, 'writer@example.com', 'writer');
    const tenderId = await seedTender(db, org.orgId, 'ext-writer-gng');

    await expect(
      asActor(db, { orgId: org.orgId, userId: writerId }, (tx) =>
        tx.query(
          "insert into go_no_go_decisions (org_id, tender_id, decision) values ($1, $2, 'go')",
          [org.orgId, tenderId]
        )
      )
    ).rejects.toThrow(/row-level security/i);

    // Un analyst sí puede.
    const analystId = await seedMember(db, org.orgId, 'analyst@example.com', 'analyst');
    const decision = await asActor(db, { orgId: org.orgId, userId: analystId }, (tx) =>
      tx.query(
        "insert into go_no_go_decisions (org_id, tender_id, decision) values ($1, $2, 'go') returning id",
        [org.orgId, tenderId]
      )
    );
    expect(decision.rows.length).toBe(1);

    // El writer no puede modificar esa decisión ya creada (USING filtra la
    // fila silenciosamente: 0 filas afectadas, sin excepción).
    const writerUpdate = await asActor(db, { orgId: org.orgId, userId: writerId }, (tx) =>
      tx.query("update go_no_go_decisions set decision = 'no_go' where id = $1", [(decision.rows[0] as any).id])
    );
    expect(writerUpdate.rowCount).toBe(0);

    // El writer sí puede escribir en proposals (redacción es su rol).
    const proposal = await asActor(db, { orgId: org.orgId, userId: writerId }, (tx) =>
      tx.query(
        "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta writer') returning id",
        [org.orgId, tenderId]
      )
    );
    expect(proposal.rows.length).toBe(1);
  });

  it('sin contexto de sesión no se ve nada (organizations, users, dominio)', async () => {
    const org = await seedOrg(db, 'org-sin-contexto');
    await seedMember(db, org.orgId, 'nadie@example.com', 'owner');
    await seedTender(db, org.orgId, 'ext-sin-contexto');

    const orgs = await asActor(db, {}, (tx) => tx.query('select id from organizations'));
    expect(orgs.rows.length).toBe(0);

    const tenders = await asActor(db, {}, (tx) => tx.query('select id from tenders'));
    expect(tenders.rows.length).toBe(0);

    const users = await asActor(db, {}, (tx) => tx.query('select id from users'));
    expect(users.rows.length).toBe(0);
  });

  it('superadmin ve todas las organizaciones y filas de dominio sin importar el contexto de org', async () => {
    const orgA = await seedOrg(db, 'org-super-a');
    const orgB = await seedOrg(db, 'org-super-b');
    await seedTender(db, orgA.orgId, 'ext-super-a');
    await seedTender(db, orgB.orgId, 'ext-super-b');
    const superId = await seedSuperadmin(db, 'super@example.com');

    // Sin org_id en el contexto: ve todo igualmente.
    const tenders = await asActor(db, { userId: superId }, (tx) => tx.query('select id from tenders'));
    expect(tenders.rows.length).toBeGreaterThanOrEqual(2);

    const orgs = await asActor(db, { userId: superId }, (tx) => tx.query('select id from organizations'));
    const orgIds = orgs.rows.map((r: any) => r.id);
    expect(orgIds).toEqual(expect.arrayContaining([orgA.orgId, orgB.orgId]));
  });

  it('un usuario normal no puede insertarse a sí mismo como superadmin', async () => {
    const org = await seedOrg(db, 'org-fake-super');
    const userId = await seedMember(db, org.orgId, 'faker@example.com', 'owner');

    await expect(
      asActor(db, { orgId: org.orgId, userId }, (tx) => tx.query('insert into platform_admins (user_id) values ($1)', [userId]))
    ).rejects.toThrow(/row-level security/i);
  });
});
