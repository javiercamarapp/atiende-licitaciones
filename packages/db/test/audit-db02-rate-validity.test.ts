import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedTender } from './helpers.js';

/**
 * Reproduce y verifica el cierre de DB-02 (docs/auditoria-1/db-api.md,
 * ALTA): `app.enforce_approved_rate` (0014_pricing.sql) validaba
 * `status='approved'` y la organización, pero NUNCA la vigencia
 * (`valid_from`/`valid_until`) de la tarifa. Una tarifa aprobada pero
 * vencida podía usarse igual en una propuesta económica -- contradice "no
 * inventar precios" (REQ-029/REQ-164) aplicado a vigencia.
 */
describe('DB-02: el trigger de tarifas aprobadas valida vigencia, no solo estado', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function seedExpiredApprovedRate(orgId: string, itemCode: string) {
    const { rows } = await db.query<{ id: string }>(
      `insert into approved_rates (org_id, item_code, description, unit_price, status, approved_at, valid_from, valid_until)
       values ($1, $2, 'Tarifa vencida', 100, 'approved', now(), current_date - interval '60 days', current_date - interval '30 days')
       returning id`,
      [orgId, itemCode]
    );
    return rows[0].id;
  }

  async function seedActiveApprovedRate(orgId: string, itemCode: string) {
    const { rows } = await db.query<{ id: string }>(
      `insert into approved_rates (org_id, item_code, description, unit_price, status, approved_at, valid_from, valid_until)
       values ($1, $2, 'Tarifa vigente', 100, 'approved', now(), current_date - interval '10 days', current_date + interval '30 days')
       returning id`,
      [orgId, itemCode]
    );
    return rows[0].id;
  }

  it('rechaza usar en una propuesta una tarifa aprobada pero con valid_until vencido', async () => {
    const org = await seedOrg(db, 'db02-org-expired');
    const tenderId = await seedTender(db, org.orgId, 'db02-ext-1');
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );
    const proposalId = proposalRows[0].id;
    const rateId = await seedExpiredApprovedRate(org.orgId, 'DB02-EXPIRED');

    await expect(
      db.query(
        `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
         values ($1, $2, $3, 1, 100, 100)`,
        [org.orgId, proposalId, rateId]
      )
    ).rejects.toThrow(/vigente|vigencia|vencid/i);
  });

  it('sigue aceptando una tarifa aprobada y vigente (no bloquea el caso correcto)', async () => {
    const org = await seedOrg(db, 'db02-org-active');
    const tenderId = await seedTender(db, org.orgId, 'db02-ext-2');
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );
    const proposalId = proposalRows[0].id;
    const rateId = await seedActiveApprovedRate(org.orgId, 'DB02-ACTIVE');

    const inserted = await db.query<{ id: string }>(
      `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
       values ($1, $2, $3, 1, 100, 100) returning id`,
      [org.orgId, proposalId, rateId]
    );
    expect(inserted.rows.length).toBe(1);
  });

  it('rechaza una tarifa aprobada cuya vigencia todavía no inicia (valid_from en el futuro)', async () => {
    const org = await seedOrg(db, 'db02-org-future');
    const tenderId = await seedTender(db, org.orgId, 'db02-ext-3');
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );
    const proposalId = proposalRows[0].id;
    const { rows: rateRows } = await db.query<{ id: string }>(
      `insert into approved_rates (org_id, item_code, description, unit_price, status, approved_at, valid_from, valid_until)
       values ($1, 'DB02-FUTURE', 'Tarifa futura', 100, 'approved', now(), current_date + interval '10 days', current_date + interval '40 days')
       returning id`,
      [org.orgId]
    );

    await expect(
      db.query(
        `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
         values ($1, $2, $3, 1, 100, 100)`,
        [org.orgId, proposalId, rateRows[0].id]
      )
    ).rejects.toThrow(/vigente|vigencia|vencid/i);
  });
});
