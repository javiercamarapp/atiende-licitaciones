import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg } from './helpers.js';

/**
 * DB-13 (MEDIA) -- docs/auditoria-1/db-api-seguridad-reverificacion.md.
 *
 * `app.enforce_approved_rate` comparaba `submission_deadline::date` contra
 * `valid_from`/`valid_until` sin fijar nunca el `TimeZone` de la sesión de
 * Postgres que hace ese cast -- el veredicto (aceptar/rechazar) dependía
 * del `TimeZone` por defecto del servidor. Fijado en
 * 0050_fix_db13_rate_validity_timezone.sql: la comparación de día
 * calendario SIEMPRE se hace en `America/Mexico_City` vía
 * `AT TIME ZONE`, sin importar el `TimeZone` de sesión.
 *
 * Este test reproduce el escenario exacto de la reverificación:
 * `submission_deadline = '2026-01-15T05:00:00Z'` (medianoche del 15 en
 * México, UTC-6) con una tarifa `valid_until = '2026-01-14'` -- debe dar el
 * MISMO veredicto (aceptado, porque en México ese instante todavía es
 * 2026-01-14) sin importar si la SESIÓN está en `UTC` o en `Asia/Tokyo`.
 */
describe('DB-13: vigencia de tarifa evaluada SIEMPRE en America/Mexico_City, sin importar el TimeZone de sesión', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function seedScenario(orgSlug: string, itemCode: string) {
    const org = await seedOrg(db, orgSlug);
    const { rows: tenderRows } = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title, submission_deadline)
       values ($1, 'test', $2, 'Tender', '2026-01-15T05:00:00Z') returning id`,
      [org.orgId, `${orgSlug}-ext`]
    );
    const { rows: rateRows } = await db.query<{ id: string }>(
      `insert into approved_rates (org_id, item_code, description, unit_price, status, approved_at, valid_from, valid_until)
       values ($1, $2, 'Tarifa', 100, 'approved', now(), '2026-01-01', '2026-01-14') returning id`,
      [org.orgId, itemCode]
    );
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderRows[0].id]
    );
    return { orgId: org.orgId, proposalId: proposalRows[0].id, rateId: rateRows[0].id };
  }

  async function attemptInsert(orgId: string, proposalId: string, rateId: string): Promise<boolean> {
    try {
      await db.query(
        `insert into proposal_pricing_lines (org_id, proposal_id, approved_rate_id, quantity, unit_price_snapshot, line_total)
         values ($1, $2, $3, 1, 100, 100)`,
        [orgId, proposalId, rateId]
      );
      return true; // aceptada
    } catch {
      return false; // rechazada
    }
  }

  it('acepta la tarifa bajo TimeZone de sesión UTC (el instante 2026-01-15T05:00:00Z cae en 2026-01-14 en America/Mexico_City)', async () => {
    await db.query("set timezone = 'UTC'");
    const { orgId, proposalId, rateId } = await seedScenario('db13-utc', 'db13-item-utc');
    const accepted = await attemptInsert(orgId, proposalId, rateId);
    expect(accepted).toBe(true);
  });

  it('acepta la MISMA tarifa/dato bajo TimeZone de sesión Asia/Tokyo -- mismo veredicto que UTC (no depende de la sesión)', async () => {
    await db.query("set timezone = 'Asia/Tokyo'");
    const { orgId, proposalId, rateId } = await seedScenario('db13-tokyo', 'db13-item-tokyo');
    const accepted = await attemptInsert(orgId, proposalId, rateId);
    expect(accepted).toBe(true);
    await db.query("set timezone = 'UTC'"); // restaurar para no afectar otros tests si comparten proceso
  });

  it('rechaza correctamente una tarifa vencida ANTES del acto incluso en America/Mexico_City explícito, bajo TimeZone de sesión Asia/Tokyo', async () => {
    await db.query("set timezone = 'Asia/Tokyo'");
    const org = await seedOrg(db, 'db13-tokyo-expired');
    const { rows: tenderRows } = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title, submission_deadline)
       values ($1, 'test', 'db13-tokyo-expired-ext', 'Tender', '2026-01-15T05:00:00Z') returning id`,
      [org.orgId]
    );
    // Esta vez la tarifa vence el 2026-01-13 -- vencida sin importar la
    // zona horaria (tanto en México como en UTC el acto es posterior).
    const { rows: rateRows } = await db.query<{ id: string }>(
      `insert into approved_rates (org_id, item_code, description, unit_price, status, approved_at, valid_from, valid_until)
       values ($1, 'db13-item-expired', 'Tarifa', 100, 'approved', now(), '2026-01-01', '2026-01-13') returning id`,
      [org.orgId]
    );
    const { rows: proposalRows } = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta') returning id",
      [org.orgId, tenderRows[0].id]
    );
    const accepted = await attemptInsert(org.orgId, proposalRows[0].id, rateRows[0].id);
    expect(accepted).toBe(false);
    await db.query("set timezone = 'UTC'");
  });
});
