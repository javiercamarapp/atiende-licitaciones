import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg } from './helpers.js';

/**
 * DB-02 (reabierto) / DB-10 (nuevo, MEDIA) --
 * docs/auditoria-1/db-api-reverificacion.md.
 *
 * `app.enforce_approved_rate` validaba vigencia solo contra `current_date`
 * ("hoy"), nunca contra `tenders.submission_deadline` (REQ-023: la
 * vigencia se compara contra la fecha del acto, no contra "hoy"). Fijado en
 * 0042_fix_db02_db10_rate_validity_submission_deadline.sql.
 */
describe('DB-02/DB-10: vigencia de tarifa validada contra submission_deadline del tender, no solo contra hoy', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function seedTenderWithDeadline(orgId: string, externalId: string, deadlineExpr: string | null) {
    const { rows } = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title, submission_deadline)
       values ($1, 'test', $2, 'Tender', ${deadlineExpr ? `(${deadlineExpr})` : 'null'})
       returning id`,
      [orgId, externalId]
    );
    return rows[0].id;
  }

  async function seedApprovedRate(orgId: string, itemCode: string, validFromExpr: string, validUntilExpr: string) {
    const { rows } = await db.query<{ id: string }>(
      `insert into approved_rates (org_id, item_code, description, unit_price, status, approved_at, valid_from, valid_until)
       values ($1, $2, 'Tarifa', 100, 'approved', now(), (${validFromExpr}), (${validUntilExpr}))
       returning id`,
      [orgId, itemCode]
    );
    return rows[0].id;
  }

  it('DB-10: rechaza una tarifa vigente HOY pero que ya habría vencido a la fecha de presentación del tender', async () => {
    const org = await seedOrg(db, 'db10-org-future-deadline');
    // La tarifa vence en 5 días (vigente HOY); el tender se presenta en 60
    // días -- para entonces la tarifa ya estará vencida.
    const tenderId = await seedTenderWithDeadline(org.orgId, 'db10-ext-1', "current_date + interval '60 days'");
    const rateId = await seedApprovedRate(
      org.orgId,
      'DB10-EXPIRES-BEFORE-DEADLINE',
      "current_date - interval '10 days'",
      "current_date + interval '5 days'"
    );
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );

    await expect(
      db.query(
        `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
         values ($1, $2, $3, 1, 100, 100)`,
        [org.orgId, proposalRows[0].id, rateId]
      )
    ).rejects.toThrow(/vigente|vigencia|vencid/i);
  });

  it('DB-10: rechaza una tarifa que HOY todavía no es vigente pero que tampoco lo será para la fecha de presentación', async () => {
    const org = await seedOrg(db, 'db10-org-not-yet');
    const tenderId = await seedTenderWithDeadline(org.orgId, 'db10-ext-2', "current_date + interval '5 days'");
    // Vigente desde +10 días -- para la fecha de presentación (+5 días)
    // todavía no ha entrado en vigor.
    const rateId = await seedApprovedRate(
      org.orgId,
      'DB10-NOT-YET-AT-DEADLINE',
      "current_date + interval '10 days'",
      "current_date + interval '40 days'"
    );
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );

    await expect(
      db.query(
        `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
         values ($1, $2, $3, 1, 100, 100)`,
        [org.orgId, proposalRows[0].id, rateId]
      )
    ).rejects.toThrow(/vigente|vigencia|vencid/i);
  });

  it('acepta una tarifa vigente tanto hoy como a la fecha de presentación del tender (no bloquea el caso correcto)', async () => {
    const org = await seedOrg(db, 'db10-org-ok');
    const tenderId = await seedTenderWithDeadline(org.orgId, 'db10-ext-3', "current_date + interval '20 days'");
    const rateId = await seedApprovedRate(
      org.orgId,
      'DB10-OK',
      "current_date - interval '10 days'",
      "current_date + interval '90 days'"
    );
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );

    const inserted = await db.query<{ id: string }>(
      `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
       values ($1, $2, $3, 1, 100, 100) returning id`,
      [org.orgId, proposalRows[0].id, rateId]
    );
    expect(inserted.rows.length).toBe(1);
  });

  it('sin submission_deadline fijado, sigue usando current_date como referencia (comportamiento de 0020 preservado)', async () => {
    const org = await seedOrg(db, 'db10-org-no-deadline');
    const tenderId = await seedTenderWithDeadline(org.orgId, 'db10-ext-4', null);
    const rateId = await seedApprovedRate(
      org.orgId,
      'DB10-EXPIRED-NO-DEADLINE',
      "current_date - interval '60 days'",
      "current_date - interval '30 days'"
    );
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderId]
    );

    await expect(
      db.query(
        `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
         values ($1, $2, $3, 1, 100, 100)`,
        [org.orgId, proposalRows[0].id, rateId]
      )
    ).rejects.toThrow(/vigente|vigencia|vencid/i);
  });
});
