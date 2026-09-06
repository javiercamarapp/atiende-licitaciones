import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, asActor, seedUser, seedSuperadmin } from './helpers.js';

/**
 * E11/REQ-050/056/REQ-057: `calendar_holidays` (0055_e11_post_award_details_and_calendar.sql)
 * es una tabla de PLATAFORMA (sin org_id, mismo patrón que `source_runs`):
 * lectura abierta a cualquier actor autenticado, escritura restringida a
 * superadmin. Prueba negativa obligatoria (REQ-057): un actor NO superadmin
 * no puede insertar/actualizar/borrar, sin importar si tiene org_id o no.
 */
describe('RLS: calendar_holidays (tabla de plataforma, solo superadmin escribe)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('un actor autenticado NO superadmin puede leer (vacía o con filas) pero NUNCA insertar', async () => {
    const userId = await seedUser(db, 'cal-rls-user@example.com');

    const read = await asActor(db, { userId }, (tx) => tx.query('select * from calendar_holidays'));
    expect(read.rows).toEqual([]);

    await expect(
      asActor(db, { userId }, (tx) =>
        tx.query(
          `insert into calendar_holidays (jurisdiction, year, holiday_date, label, source_url, source_consulted_on)
           values ('federal', 2026, '2026-12-25', 'Navidad', 'https://www.gob.mx/buengobierno/calendario-2026', '2026-09-06')`
        )
      )
    ).rejects.toThrow();
  });

  it('superadmin puede insertar, actualizar y borrar; el resultado es visible a cualquier lector', async () => {
    const superadminUserId = await seedSuperadmin(db, 'cal-rls-superadmin@example.com');
    const otherUserId = await seedUser(db, 'cal-rls-reader@example.com');

    await asActor(db, { userId: superadminUserId }, (tx) =>
      tx.query(
        `insert into calendar_holidays (jurisdiction, year, holiday_date, label, source_url, source_consulted_on)
         values ('federal', 2026, '2026-12-25', 'Navidad', 'https://www.gob.mx/buengobierno/calendario-2026', '2026-09-06')`
      )
    );

    const readByOther = await asActor(db, { userId: otherUserId }, (tx) => tx.query('select label from calendar_holidays'));
    expect(readByOther.rows.map((r: any) => r.label)).toEqual(['Navidad']);

    await asActor(db, { userId: superadminUserId }, (tx) =>
      tx.query("update calendar_holidays set label = 'Navidad (actualizado)' where jurisdiction = 'federal' and holiday_date = '2026-12-25'")
    );
    const afterUpdate = await asActor(db, { userId: otherUserId }, (tx) => tx.query('select label from calendar_holidays'));
    expect(afterUpdate.rows[0].label).toBe('Navidad (actualizado)');

    await expect(
      asActor(db, { userId: otherUserId }, (tx) =>
        tx.query("delete from calendar_holidays where jurisdiction = 'federal' and holiday_date = '2026-12-25'")
      )
    ).resolves.toBeDefined(); // DELETE sin filas afectadas por RLS no lanza -- se verifica abajo que la fila SIGUE existiendo.
    const stillThere = await asActor(db, { userId: otherUserId }, (tx) => tx.query('select 1 from calendar_holidays'));
    expect(stillThere.rows.length).toBe(1);

    await asActor(db, { userId: superadminUserId }, (tx) =>
      tx.query("delete from calendar_holidays where jurisdiction = 'federal' and holiday_date = '2026-12-25'")
    );
    const afterDelete = await asActor(db, { userId: otherUserId }, (tx) => tx.query('select 1 from calendar_holidays'));
    expect(afterDelete.rows.length).toBe(0);
  });
});
