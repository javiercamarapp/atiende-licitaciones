import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, asActor, DOMAIN_TABLES } from './helpers.js';

describe('aislamiento multi-tenant (RLS) por tabla de dominio', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  for (const spec of DOMAIN_TABLES) {
    describe(`tabla ${spec.table}`, () => {
      it('un owner de la organización A no ve, edita ni borra filas de la organización B', async () => {
        const orgA = await seedOrg(db, `org-a-${spec.table}`);
        const orgB = await seedOrg(db, `org-b-${spec.table}`);
        const ownerA = await seedMember(db, orgA.orgId, `owner-a-${spec.table}@example.com`, 'owner');
        await seedMember(db, orgB.orgId, `owner-b-${spec.table}@example.com`, 'owner');

        const auxA = spec.seedAux ? await spec.seedAux(db, orgA.orgId) : {};
        const auxB = spec.seedAux ? await spec.seedAux(db, orgB.orgId) : {};
        const rowAId = await spec.insertRow(db, orgA.orgId, auxA);
        const rowBId = await spec.insertRow(db, orgB.orgId, auxB);

        // SELECT: A solo ve su propia fila, nunca la de B.
        const seen = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
          tx.query(`select id from ${spec.table} where id in ($1, $2)`, [rowAId, rowBId])
        );
        const seenIds = seen.rows.map((r: any) => r.id);
        expect(seenIds).toContain(rowAId);
        expect(seenIds).not.toContain(rowBId);

        // UPDATE cross-org: no debe afectar ninguna fila (rowCount 0), no debe lanzar,
        // simplemente no encuentra la fila porque RLS la oculta. Se usa
        // `created_at = created_at` (no-op) porque es la única columna común
        // a TODAS las tablas de dominio (algunas, como tender_versions o
        // tender_change_events, son de historial append-only sin updated_at).
        const upd = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
          tx.query(`update ${spec.table} set created_at = created_at where id = $1`, [rowBId])
        );
        expect(upd.rowCount).toBe(0);

        // DELETE cross-org: tampoco borra nada.
        const del = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
          tx.query(`delete from ${spec.table} where id = $1`, [rowBId])
        );
        expect(del.rowCount).toBe(0);

        // La fila de B sigue existiendo (verificado desde el owner de B).
        const stillThere = await asActor(db, { orgId: orgB.orgId, userId: await seedMember(db, orgB.orgId, `check-${spec.table}@example.com`, 'owner') }, (tx) =>
          tx.query(`select id from ${spec.table} where id = $1`, [rowBId])
        );
        expect(stillThere.rows.length).toBe(1);
      });

      it('sin contexto de sesión (sin org ni usuario) no se ve ninguna fila', async () => {
        const org = await seedOrg(db, `org-noctx-${spec.table}`);
        const aux = spec.seedAux ? await spec.seedAux(db, org.orgId) : {};
        const rowId = await spec.insertRow(db, org.orgId, aux);

        const seen = await asActor(db, {}, (tx) => tx.query(`select id from ${spec.table} where id = $1`, [rowId]));
        expect(seen.rows.length).toBe(0);
      });
    });
  }
});
