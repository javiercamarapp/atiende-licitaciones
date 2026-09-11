import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedTender, asActor } from './helpers.js';

/**
 * REQ-040 ("sala de guerra"): `war_room_checklist_runs` (migración 0099) es
 * un historial INMUTABLE (mismo patrón que `collection_status_history` /
 * `contract_status_history`, ninguna de las tres está en `DOMAIN_TABLES`
 * genérico -- se prueba en su propio archivo, siguiendo el precedente
 * documentado en `rls-ronda3-expediente.test.ts`). Cubre: aislamiento
 * multi-tenant, que ningún rol puede UPDATE/DELETE (append-only por
 * ausencia de política, no por lógica de aplicación), y que `viewer` puede
 * leer pero no puede insertar una corrida nueva.
 */

async function insertProposal(db: DbClient, orgId: string, externalId: string): Promise<{ tenderId: string; proposalId: string }> {
  const tenderId = await seedTender(db, orgId, externalId);
  const { rows } = await db.query<{ id: string }>(
    "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
    [orgId, tenderId]
  );
  return { tenderId, proposalId: rows[0].id };
}

async function insertRun(db: DbClient, orgId: string, tenderId: string, proposalId: string, overallStatus: string = 'verde'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into war_room_checklist_runs (org_id, tender_id, proposal_id, overall_status, items)
     values ($1, $2, $3, $4, '[]'::jsonb) returning id`,
    [orgId, tenderId, proposalId, overallStatus]
  );
  return rows[0].id;
}

describe('war_room_checklist_runs — RLS (REQ-040)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('un owner de la organización A no ve, edita ni borra corridas de la organización B', async () => {
    const orgA = await seedOrg(db, 'org-a-warroom');
    const orgB = await seedOrg(db, 'org-b-warroom');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-a-warroom@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'owner-b-warroom@example.com', 'owner');

    const { tenderId: tenderA, proposalId: proposalA } = await insertProposal(db, orgA.orgId, 'wr-a-001');
    const { tenderId: tenderB, proposalId: proposalB } = await insertProposal(db, orgB.orgId, 'wr-b-001');
    const runA = await insertRun(db, orgA.orgId, tenderA, proposalA);
    const runB = await insertRun(db, orgB.orgId, tenderB, proposalB, 'rojo');

    const seen = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query('select id from war_room_checklist_runs where id in ($1, $2)', [runA, runB])
    );
    const seenIds = seen.rows.map((r: any) => r.id);
    expect(seenIds).toContain(runA);
    expect(seenIds).not.toContain(runB);

    // Ninguna política de UPDATE/DELETE existe para nadie (append-only) --
    // el intento cross-org (y de hecho cualquier intento, incluso dentro de
    // la propia org) no debe afectar ninguna fila.
    const upd = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query("update war_room_checklist_runs set overall_status = 'rojo' where id = $1", [runB])
    );
    expect(upd.rowCount).toBe(0);
    const del = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query('delete from war_room_checklist_runs where id = $1', [runB])
    );
    expect(del.rowCount).toBe(0);

    const stillThere = await asActor(db, { orgId: orgB.orgId, userId: await seedMember(db, orgB.orgId, 'check-warroom@example.com', 'owner') }, (tx) =>
      tx.query('select id, overall_status from war_room_checklist_runs where id = $1', [runB])
    );
    expect(stillThere.rows.length).toBe(1);
    expect((stillThere.rows[0] as any).overall_status).toBe('rojo');
  });

  it('append-only: incluso el propio owner NO puede editar una corrida ya guardada, en su propia organización', async () => {
    const org = await seedOrg(db, 'org-warroom-immutable');
    const owner = await seedMember(db, org.orgId, 'owner-warroom-immutable@example.com', 'owner');
    const { tenderId, proposalId } = await insertProposal(db, org.orgId, 'wr-immutable-001');
    const runId = await insertRun(db, org.orgId, tenderId, proposalId, 'verde');

    const upd = await asActor(db, { orgId: org.orgId, userId: owner }, (tx) =>
      tx.query("update war_room_checklist_runs set overall_status = 'rojo' where id = $1", [runId])
    );
    expect(upd.rowCount).toBe(0);

    const still = await asActor(db, { orgId: org.orgId, userId: owner }, (tx) =>
      tx.query('select overall_status from war_room_checklist_runs where id = $1', [runId])
    );
    expect((still.rows[0] as any).overall_status).toBe('verde');
  });

  it('viewer puede leer el historial pero no puede correr (INSERT) un checklist nuevo', async () => {
    const org = await seedOrg(db, 'org-warroom-viewer');
    const viewerId = await seedMember(db, org.orgId, 'viewer-warroom@example.com', 'viewer');
    await seedMember(db, org.orgId, 'writer-warroom@example.com', 'writer');
    const { tenderId, proposalId } = await insertProposal(db, org.orgId, 'wr-viewer-001');
    const runId = await insertRun(db, org.orgId, tenderId, proposalId);

    const seen = await asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
      tx.query('select id from war_room_checklist_runs where id = $1', [runId])
    );
    expect(seen.rows.length).toBe(1);

    await expect(
      asActor(db, { orgId: org.orgId, userId: viewerId }, (tx) =>
        tx.query(
          `insert into war_room_checklist_runs (org_id, tender_id, proposal_id, overall_status, items) values ($1, $2, $3, 'verde', '[]'::jsonb)`,
          [org.orgId, tenderId, proposalId]
        )
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('writer sí puede insertar una corrida nueva (rol de escritura habitual del dominio expediente)', async () => {
    const org = await seedOrg(db, 'org-warroom-writer');
    const writerId = await seedMember(db, org.orgId, 'writer-insert-warroom@example.com', 'writer');
    const { tenderId, proposalId } = await insertProposal(db, org.orgId, 'wr-writer-001');

    const inserted = await asActor(db, { orgId: org.orgId, userId: writerId }, (tx) =>
      tx.query(
        `insert into war_room_checklist_runs (org_id, tender_id, proposal_id, overall_status, items) values ($1, $2, $3, 'ambar', '[]'::jsonb) returning id`,
        [org.orgId, tenderId, proposalId]
      )
    );
    expect(inserted.rows.length).toBe(1);
  });

  it('sin contexto de sesión (sin org ni usuario) no se ve ninguna fila', async () => {
    const org = await seedOrg(db, 'org-warroom-noctx');
    const { tenderId, proposalId } = await insertProposal(db, org.orgId, 'wr-noctx-001');
    const runId = await insertRun(db, org.orgId, tenderId, proposalId);

    const seen = await asActor(db, {}, (tx) => tx.query('select id from war_room_checklist_runs where id = $1', [runId]));
    expect(seen.rows.length).toBe(0);
  });
});
