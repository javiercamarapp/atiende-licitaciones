import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedUser } from './helpers.js';

/**
 * Reproduce y verifica el cierre de DB-03 (docs/auditoria-1/db-api.md,
 * ALTA): no existía ningún mecanismo que revirtiera la aprobación de una
 * tarifa si su precio (u otro campo material) cambiaba después de
 * aprobada. `UPDATE approved_rates SET unit_price = ... WHERE status =
 * 'approved'` tenía éxito y el status seguía 'approved' -- contradice el
 * espíritu de REQ-162 (cambiar un insumo ya aprobado exige nueva revisión)
 * aplicado a precios.
 */
describe('DB-03: editar el precio de una tarifa aprobada exige nueva aprobación', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function seedApprovedRate(orgId: string, itemCode: string, approverId: string) {
    const { rows } = await db.query<{ id: string }>(
      `insert into approved_rates (org_id, item_code, description, unit_price, status, approved_by, approved_at)
       values ($1, $2, 'Tarifa de prueba', 100, 'approved', $3, now())
       returning id`,
      [orgId, itemCode, approverId]
    );
    return rows[0].id;
  }

  it('cambiar unit_price de una tarifa aprobada la regresa a draft y limpia approved_by/approved_at', async () => {
    const org = await seedOrg(db, 'db03-org-price');
    const approver = await seedUser(db, 'db03-approver@example.com');
    const rateId = await seedApprovedRate(org.orgId, 'DB03-PRICE', approver);

    await db.query('update approved_rates set unit_price = 999 where id = $1', [rateId]);

    const { rows } = await db.query<{ status: string; approved_by: string | null; approved_at: string | null; unit_price: string }>(
      'select status, approved_by, approved_at, unit_price from approved_rates where id = $1',
      [rateId]
    );
    expect(rows[0].status).toBe('draft');
    expect(rows[0].approved_by).toBeNull();
    expect(rows[0].approved_at).toBeNull();
    expect(Number(rows[0].unit_price)).toBe(999);
  });

  it('cambiar un campo no material (p.ej. description) NO revoca una tarifa ya aprobada', async () => {
    const org = await seedOrg(db, 'db03-org-desc');
    const approver = await seedUser(db, 'db03-approver2@example.com');
    const rateId = await seedApprovedRate(org.orgId, 'DB03-DESC', approver);

    await db.query("update approved_rates set description = 'Descripción actualizada, mismo precio' where id = $1", [
      rateId,
    ]);

    const { rows } = await db.query<{ status: string }>('select status from approved_rates where id = $1', [rateId]);
    expect(rows[0].status).toBe('approved');
  });

  it('la propia transición explícita a approved (flujo normal de aprobación) no se revoca a sí misma', async () => {
    const org = await seedOrg(db, 'db03-org-approve-flow');
    const approver = await seedUser(db, 'db03-approver3@example.com');
    const { rows: draftRows } = await db.query<{ id: string }>(
      `insert into approved_rates (org_id, item_code, description, unit_price, status)
       values ($1, 'DB03-FLOW', 'Tarifa', 50, 'draft') returning id`,
      [org.orgId]
    );
    const rateId = draftRows[0].id;

    await db.query('update approved_rates set status = $1, approved_by = $2, approved_at = now() where id = $3', [
      'approved',
      approver,
      rateId,
    ]);

    const { rows } = await db.query<{ status: string }>('select status from approved_rates where id = $1', [rateId]);
    expect(rows[0].status).toBe('approved');
  });
});
