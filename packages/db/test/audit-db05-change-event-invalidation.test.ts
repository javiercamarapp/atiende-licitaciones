import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedTender } from './helpers.js';

/**
 * Reproduce y verifica el cierre de DB-05 (docs/auditoria-1/db-api.md,
 * ALTA): insertar un `tender_change_events` no invalidaba automáticamente
 * ningún dependiente (`proposals`/`requirement_items`/`compliance_items`/
 * `proposal_approvals`) del mismo `tender_id`. Las columnas
 * `invalidated_at`/`invalidated_reason` existían desde 0012 pero nunca se
 * llenaban solas -- REQ-155/REQ-162 (invalidación automática, "tolerancia
 * cero") no estaban cerrados a nivel de base de datos.
 */
describe('DB-05: insertar tender_change_events invalida automáticamente los dependientes', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('invalida proposals/requirement_items/compliance_items del mismo tender al insertar un change_event', async () => {
    const org = await seedOrg(db, 'db05-org-1');
    const tenderId = await seedTender(db, org.orgId, 'db05-ext-1');

    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );
    const proposalId = proposalRows[0].id;

    const { rows: reqRows } = await db.query<{ id: string }>(
      "insert into requirement_items (org_id, tender_id, description) values ($1, $2, 'Requisito') returning id",
      [org.orgId, tenderId]
    );
    const { rows: compRows } = await db.query<{ id: string }>(
      "insert into compliance_items (org_id, tender_id, label) values ($1, $2, 'Checklist') returning id",
      [org.orgId, tenderId]
    );

    // Precondición: nada invalidado todavía.
    const before = await db.query<{ invalidated_at: string | null }>('select invalidated_at from proposals where id = $1', [
      proposalId,
    ]);
    expect(before.rows[0].invalidated_at).toBeNull();

    await db.query(
      "insert into tender_change_events (org_id, tender_id, change_kind, summary) values ($1, $2, 'deadline_change', 'Plazo adelantado')",
      [org.orgId, tenderId]
    );

    const proposalAfter = await db.query<{ invalidated_at: string | null; invalidated_reason: string | null }>(
      'select invalidated_at, invalidated_reason from proposals where id = $1',
      [proposalId]
    );
    expect(proposalAfter.rows[0].invalidated_at).not.toBeNull();
    expect(proposalAfter.rows[0].invalidated_reason).toMatch(/deadline_change/);

    const reqAfter = await db.query<{ invalidated_at: string | null }>(
      'select invalidated_at from requirement_items where id = $1',
      [reqRows[0].id]
    );
    expect(reqAfter.rows[0].invalidated_at).not.toBeNull();

    const compAfter = await db.query<{ invalidated_at: string | null }>(
      'select invalidated_at from compliance_items where id = $1',
      [compRows[0].id]
    );
    expect(compAfter.rows[0].invalidated_at).not.toBeNull();
  });

  it('marca proposal_approvals aprobadas como invalidated cuando cambia el tender del que dependen', async () => {
    const org = await seedOrg(db, 'db05-org-2');
    const tenderId = await seedTender(db, org.orgId, 'db05-ext-2');
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );
    const proposalId = proposalRows[0].id;
    const { rows: approvalRows } = await db.query<{ id: string }>(
      "insert into proposal_approvals (org_id, proposal_id, approver_role, status) values ($1, $2, 'owner', 'approved') returning id",
      [org.orgId, proposalId]
    );

    await db.query(
      "insert into tender_change_events (org_id, tender_id, change_kind, summary) values ($1, $2, 'amendment', 'Aclaración')",
      [org.orgId, tenderId]
    );

    const { rows } = await db.query<{ status: string }>('select status from proposal_approvals where id = $1', [
      approvalRows[0].id,
    ]);
    expect(rows[0].status).toBe('invalidated');
  });

  it('no toca dependientes de OTRO tender (aislamiento por tender_id)', async () => {
    const org = await seedOrg(db, 'db05-org-3');
    const tenderA = await seedTender(db, org.orgId, 'db05-ext-3a');
    const tenderB = await seedTender(db, org.orgId, 'db05-ext-3b');
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta B') returning id",
      [org.orgId, tenderB]
    );

    await db.query(
      "insert into tender_change_events (org_id, tender_id, change_kind) values ($1, $2, 'amendment')",
      [org.orgId, tenderA]
    );

    const { rows } = await db.query<{ invalidated_at: string | null }>(
      'select invalidated_at from proposals where id = $1',
      [proposalRows[0].id]
    );
    expect(rows[0].invalidated_at).toBeNull();
  });

  it('no reescribe una invalidación ya marcada (invalidated_at is null guard)', async () => {
    const org = await seedOrg(db, 'db05-org-4');
    const tenderId = await seedTender(db, org.orgId, 'db05-ext-4');
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );

    await db.query("insert into tender_change_events (org_id, tender_id, change_kind) values ($1, $2, 'amendment')", [
      org.orgId,
      tenderId,
    ]);
    const first = await db.query<{ invalidated_at: string }>('select invalidated_at from proposals where id = $1', [
      proposalRows[0].id,
    ]);
    const firstTimestamp = first.rows[0].invalidated_at;

    await db.query("insert into tender_change_events (org_id, tender_id, change_kind) values ($1, $2, 'clarification')", [
      org.orgId,
      tenderId,
    ]);
    const second = await db.query<{ invalidated_at: string }>('select invalidated_at from proposals where id = $1', [
      proposalRows[0].id,
    ]);
    expect(new Date(second.rows[0].invalidated_at).getTime()).toBe(new Date(firstTimestamp).getTime());
  });
});
