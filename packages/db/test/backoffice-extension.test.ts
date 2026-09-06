import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedSuperadmin, seedTender, asActor } from './helpers.js';

describe('ampliación back office: reglas de negocio a nivel de esquema', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('una propuesta económica NO puede referenciar una tarifa que no esté aprobada (trigger a nivel de esquema)', async () => {
    const org = await seedOrg(db, 'org-rate-enforce');
    const ownerId = await seedMember(db, org.orgId, 'owner-rate@example.com', 'owner');
    const tenderId = await seedTender(db, org.orgId, 'ext-rate-enforce');

    const proposal = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string }>(
        "insert into proposals (org_id, tender_id, title) values ($1, $2, 'P') returning id",
        [org.orgId, tenderId]
      )
    );
    const proposalId = (proposal.rows[0] as any).id;

    const draftRate = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string }>(
        "insert into approved_rates (org_id, item_code, description, unit_price, status) values ($1, 'SKU-1', 'x', 50, 'draft') returning id",
        [org.orgId]
      )
    );
    const draftRateId = (draftRate.rows[0] as any).id;

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query(
          `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
           values ($1, $2, $3, 1, 50, 50)`,
          [org.orgId, proposalId, draftRateId]
        )
      )
    ).rejects.toThrow(/no está aprobada/i);

    // Al aprobar la tarifa, la misma línea sí se puede crear.
    await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query("update approved_rates set status = 'approved', approved_at = now() where id = $1", [draftRateId])
    );

    const ok = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query(
        `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
         values ($1, $2, $3, 1, 50, 50) returning id`,
        [org.orgId, proposalId, draftRateId]
      )
    );
    expect(ok.rows.length).toBe(1);
  });

  it('un package_manifest no puede quedar en estado "ready" sin checklist_snapshot (constraint de esquema)', async () => {
    const org = await seedOrg(db, 'org-package-ready');
    const ownerId = await seedMember(db, org.orgId, 'owner-pkg@example.com', 'owner');
    const tenderId = await seedTender(db, org.orgId, 'ext-package-ready');
    const proposal = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string }>(
        "insert into proposals (org_id, tender_id, title) values ($1, $2, 'P') returning id",
        [org.orgId, tenderId]
      )
    );
    const proposalId = (proposal.rows[0] as any).id;

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query("insert into package_manifests (org_id, proposal_id, status) values ($1, $2, 'ready')", [
          org.orgId,
          proposalId,
        ])
      )
    ).rejects.toThrow(/package_ready_requires_checklist|check constraint/i);

    const ok = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query(
        "insert into package_manifests (org_id, proposal_id, status, checklist_snapshot) values ($1, $2, 'ready', '{\"items\":[]}'::jsonb) returning id",
        [org.orgId, proposalId]
      )
    );
    expect(ok.rows.length).toBe(1);
  });

  it('tender_versions deduplica por (org, tender, source_version): reintentar la misma versión de origen no crea duplicado', async () => {
    const org = await seedOrg(db, 'org-version-dedupe');
    const ownerId = await seedMember(db, org.orgId, 'owner-ver@example.com', 'owner');
    const tenderId = await seedTender(db, org.orgId, 'ext-version-dedupe');

    await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query(
        "insert into tender_versions (org_id, tender_id, change_kind, source_version) values ($1, $2, 'publication', 'src-v1')",
        [org.orgId, tenderId]
      )
    );

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query(
          "insert into tender_versions (org_id, tender_id, change_kind, source_version) values ($1, $2, 'publication', 'src-v1')",
          [org.orgId, tenderId]
        )
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('source_runs es de plataforma: sin org_id y visible SOLO para superadmin, ni siquiera para un owner de organización', async () => {
    const org = await seedOrg(db, 'org-source-runs');
    const ownerId = await seedMember(db, org.orgId, 'owner-src@example.com', 'owner');
    const superId = await seedSuperadmin(db, 'super-src@example.com');

    await db.query(
      "insert into source_runs (source_id, status, evidence) values ('compranet', 'ok', '{}'::jsonb)"
    );

    const asOwner = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query('select id from source_runs')
    );
    expect(asOwner.rows.length).toBe(0);

    const asSuper = await asActor(db, { userId: superId }, (tx) => tx.query('select id from source_runs'));
    expect(asSuper.rows.length).toBeGreaterThanOrEqual(1);

    // Un owner normal tampoco puede insertar un source_run.
    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query("insert into source_runs (source_id, status) values ('otra-fuente', 'ok')")
      )
    ).rejects.toThrow(/row-level security/i);
  });

  it('un cambio de bases (tender_change_event) puede invalidar una propuesta dependiente (columna invalidated_at)', async () => {
    const org = await seedOrg(db, 'org-invalidation');
    const ownerId = await seedMember(db, org.orgId, 'owner-inv@example.com', 'owner');
    const tenderId = await seedTender(db, org.orgId, 'ext-invalidation');

    const proposal = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string }>(
        "insert into proposals (org_id, tender_id, title) values ($1, $2, 'P') returning id",
        [org.orgId, tenderId]
      )
    );
    const proposalId = (proposal.rows[0] as any).id;

    const event = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ id: string }>(
        "insert into tender_change_events (org_id, tender_id, change_kind, summary) values ($1, $2, 'deadline_change', 'Plazo adelantado') returning id",
        [org.orgId, tenderId]
      )
    );
    const eventId = (event.rows[0] as any).id;

    await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query(
        "update proposals set invalidated_at = now(), invalidated_reason = 'Cambio de plazo' where id = $1",
        [proposalId]
      )
    );

    const check = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query<{ invalidated_reason: string }>('select invalidated_reason from proposals where id = $1', [
        proposalId,
      ])
    );
    expect((check.rows[0] as any).invalidated_reason).toBe('Cambio de plazo');
    expect(eventId).toBeTruthy();
  });
});
