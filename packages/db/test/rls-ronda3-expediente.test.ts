import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedTender, asActor } from './helpers.js';

/**
 * Ronda 3 (E6-E8, apps/api): aislamiento multi-tenant de las tablas nuevas
 * de esta ronda (0029-0034) que `test/rls-isolation.test.ts` no cubre
 * (ese archivo usa `DOMAIN_TABLES`, una lista existente que esta ronda no
 * debe editar -- ver alcance "packages/db/test/** solo añadir archivos
 * nuevos"): `requirement_conflicts`, `proposal_approval_events`,
 * `proposal_comments`. También verifica la política de escritura corregida
 * de `proposal_approvals` (0031): reviewer SÍ puede insertar/actualizar
 * (antes solo decision_roles = owner/admin/analyst, sin reviewer);
 * `analyst` YA NO puede (antes sí, vía decision_roles heredado de 0016).
 */
describe('ronda 3 — aislamiento multi-tenant de tablas nuevas del expediente', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('requirement_conflicts: un owner de la organización A no ve ni edita conflictos de la organización B', async () => {
    const orgA = await seedOrg(db, 'r3-org-a-conflicts');
    const orgB = await seedOrg(db, 'r3-org-b-conflicts');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a-conflicts@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'owner-b-conflicts@example.com', 'owner');
    const tenderA = await seedTender(db, orgA.orgId, 'ext-a-conflicts');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-b-conflicts');

    const { rows: rowsA } = await db.query<{ id: string }>(
      "insert into requirement_conflicts (org_id, tender_id, topic_key, kind, description) values ($1, $2, 'plazo', 'deadline_mismatch', 'conflicto A') returning id",
      [orgA.orgId, tenderA]
    );
    const { rows: rowsB } = await db.query<{ id: string }>(
      "insert into requirement_conflicts (org_id, tender_id, topic_key, kind, description) values ($1, $2, 'plazo', 'deadline_mismatch', 'conflicto B') returning id",
      [orgB.orgId, tenderB]
    );

    const seen = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query('select id from requirement_conflicts where id in ($1, $2)', [rowsA[0].id, rowsB[0].id])
    );
    expect(seen.rows.map((r) => r.id)).toEqual([rowsA[0].id]);

    const resolveAttempt = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query("update requirement_conflicts set status = 'resuelto' where id = $1", [rowsB[0].id])
    );
    expect(resolveAttempt.rowCount).toBe(0);
  });

  it('proposal_approval_events y proposal_comments: aislados por organización', async () => {
    const orgA = await seedOrg(db, 'r3-org-a-events');
    const orgB = await seedOrg(db, 'r3-org-b-events');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a-events@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'owner-b-events@example.com', 'owner');
    const tenderA = await seedTender(db, orgA.orgId, 'ext-a-events');
    const tenderB = await seedTender(db, orgB.orgId, 'ext-b-events');
    const { rows: propA } = await db.query<{ id: string }>("insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta A') returning id", [orgA.orgId, tenderA]);
    const { rows: propB } = await db.query<{ id: string }>("insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta B') returning id", [orgB.orgId, tenderB]);

    await db.query("insert into proposal_approval_events (org_id, proposal_id, kind, actor_role, scope_ref) values ($1, $2, 'comment', 'owner', 'expediente')", [orgA.orgId, propA[0].id]);
    await db.query("insert into proposal_approval_events (org_id, proposal_id, kind, actor_role, scope_ref) values ($1, $2, 'comment', 'owner', 'expediente')", [orgB.orgId, propB[0].id]);
    await db.query("insert into proposal_comments (org_id, proposal_id, scope_ref, author_role, body) values ($1, $2, 'expediente', 'owner', 'comentario A')", [orgA.orgId, propA[0].id]);
    await db.query("insert into proposal_comments (org_id, proposal_id, scope_ref, author_role, body) values ($1, $2, 'expediente', 'owner', 'comentario B')", [orgB.orgId, propB[0].id]);

    const eventsSeen = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select org_id from proposal_approval_events'));
    expect(eventsSeen.rows.every((r) => r.org_id === orgA.orgId)).toBe(true);
    expect(eventsSeen.rows.length).toBeGreaterThan(0);

    const commentsSeen = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) => tx.query('select body from proposal_comments'));
    expect(commentsSeen.rows.map((r) => r.body)).toEqual(['comentario A']);
  });

  it('proposal_approvals (0031): reviewer SÍ puede insertar/actualizar; analyst YA NO (corrección de política heredada de decision_roles)', async () => {
    const org = await seedOrg(db, 'r3-org-approval-roles');
    const reviewerId = await seedMember(db, org.orgId, 'reviewer-approval-roles@example.com', 'reviewer');
    const analystId = await seedMember(db, org.orgId, 'analyst-approval-roles@example.com', 'analyst');
    const tenderId = await seedTender(db, org.orgId, 'ext-approval-roles');
    const { rows: prop } = await db.query<{ id: string }>("insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id", [org.orgId, tenderId]);

    const byReviewer = await asActor(db, { orgId: org.orgId, userId: reviewerId }, (tx) =>
      tx.query(
        "insert into proposal_approvals (org_id, proposal_id, approver_role, approver_id, status, scope, scope_ref, inputs_hash) values ($1, $2, 'reviewer', $3, 'approved', 'expediente', 'expediente', 'hash-reviewer') returning id",
        [org.orgId, prop[0].id, reviewerId]
      )
    );
    expect(byReviewer.rows.length).toBe(1);

    await expect(
      asActor(db, { orgId: org.orgId, userId: analystId }, (tx) =>
        tx.query(
          "insert into proposal_approvals (org_id, proposal_id, approver_role, approver_id, status, scope, scope_ref, inputs_hash) values ($1, $2, 'analyst', $3, 'approved', 'expediente', 'expediente', 'hash-analyst') returning id",
          [org.orgId, prop[0].id, analystId]
        )
      )
    ).rejects.toThrow();
  });
});
