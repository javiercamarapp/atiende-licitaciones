import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedUser } from './helpers.js';

/**
 * Reproduce y verifica el cierre de DB-06 (docs/auditoria-1/db-api.md,
 * MEDIA): `audit_log` es append-only (RLS sin política UPDATE/DELETE,
 * confirmado por la suite oficial), pero no existía ningún "hash
 * encadenado" -- REQ-083 solo estaba cumplido a medias.
 */
describe('DB-06: audit_log mantiene una cadena de hashes verificable', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('cada INSERT calcula hash/prev_hash automáticamente, encadenando con la fila anterior', async () => {
    const org = await seedOrg(db, 'db06-org-1');
    const user = await seedUser(db, 'db06-user@example.com');

    const first = await db.query<{ id: string; hash: string; prev_hash: string | null }>(
      "insert into audit_log (org_id, actor_id, action, entity) values ($1, $2, 'test.action.one', 'thing') returning id, hash, prev_hash",
      [org.orgId, user]
    );
    expect(first.rows[0].hash).toBeTruthy();
    expect(typeof first.rows[0].hash).toBe('string');
    expect(first.rows[0].hash.length).toBe(64); // sha256 hex

    const second = await db.query<{ id: string; hash: string; prev_hash: string | null }>(
      "insert into audit_log (org_id, actor_id, action, entity) values ($1, $2, 'test.action.two', 'thing') returning id, hash, prev_hash",
      [org.orgId, user]
    );
    expect(second.rows[0].prev_hash).toBe(first.rows[0].hash);
    expect(second.rows[0].hash).not.toBe(first.rows[0].hash);
  });

  it('app.verify_audit_log_chain() confirma una cadena íntegra', async () => {
    const org = await seedOrg(db, 'db06-org-2');
    const user = await seedUser(db, 'db06-user2@example.com');
    for (let i = 0; i < 5; i++) {
      await db.query("insert into audit_log (org_id, actor_id, action, entity) values ($1, $2, $3, 'thing')", [
        org.orgId,
        user,
        `test.action.${i}`,
      ]);
    }

    const { rows } = await db.query<{ ok: boolean; broken_at: string | null }>('select * from app.verify_audit_log_chain()');
    expect(rows[0].ok).toBe(true);
    expect(rows[0].broken_at).toBeNull();
  });

  it('app.verify_audit_log_chain() detecta manipulación directa de una fila (hash recalculado no coincide)', async () => {
    const org = await seedOrg(db, 'db06-org-3');
    const user = await seedUser(db, 'db06-user3@example.com');
    const { rows: inserted } = await db.query<{ id: string }>(
      "insert into audit_log (org_id, actor_id, action, entity) values ($1, $2, 'test.action.tamper', 'thing') returning id",
      [org.orgId, user]
    );
    await db.query("insert into audit_log (org_id, actor_id, action, entity) values ($1, $2, 'test.action.after', 'thing')", [
      org.orgId,
      user,
    ]);

    // Manipulación directa como el propietario de las migraciones (fuera de
    // RLS, simulando acceso administrativo/superusuario a la base): cambia
    // el contenido de `after` sin recalcular el hash -- exactamente lo que
    // la cadena de hashes debe poder detectar aunque el UPDATE en sí no
    // esté permitido vía RLS para app_role.
    await db.query("update audit_log set after = '{\"tampered\": true}'::jsonb where id = $1", [inserted[0].id]);

    const { rows } = await db.query<{ ok: boolean; broken_at: string | null }>('select * from app.verify_audit_log_chain()');
    expect(rows[0].ok).toBe(false);
    expect(rows[0].broken_at).toBe(inserted[0].id);
  });
});
