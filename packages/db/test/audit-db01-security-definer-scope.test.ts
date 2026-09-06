import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedUser, asActor } from './helpers.js';

/**
 * Reproduce y verifica el cierre de DB-01 (docs/auditoria-1/db-api.md,
 * ALTA): `app.membership_role`/`app.find_user_by_email` (0010) eran
 * invocables directamente por cualquier sesión con parámetros arbitrarios,
 * filtrando el rol real de un usuario de otra organización y el
 * `password_hash` de cualquier usuario. La corrección (0019) hace que
 * `app.membership_role` solo pueda resolver la membresía del PROPIO actor
 * (usa `app.current_user_id()` internamente, ya no acepta un `p_user_id`
 * arbitrario) y que `app.find_user_by_email` se niegue a ejecutarse si ya
 * existe un `app.current_user_id()` fijado en la sesión (solo utilizable en
 * el contexto "pre-sesión" para el que fue diseñada, login).
 */
describe('DB-01: funciones SECURITY DEFINER ya no filtran datos de otro actor/usuario', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('app.membership_role(org_id, user_id) de 2 argumentos (vulnerable) ya no existe', async () => {
    const org = await seedOrg(db, 'db01-org-a');
    const userA = await seedMember(db, org.orgId, 'db01-user-a@example.com', 'owner');
    await seedUser(db, 'db01-attacker@example.com');

    // Antes de 0019, esta llamada devolvía 'owner' (el rol REAL de userA) a
    // cualquier llamador, sin verificar que el llamador tuviera relación
    // alguna con userA o con la organización. Ahora la función de 2
    // argumentos ni siquiera existe: debe fallar con "function ... does not
    // exist", no con un valor.
    await expect(db.query('select app.membership_role($1, $2) as role', [org.orgId, userA])).rejects.toThrow();
  });

  it('app.membership_role(org_id) de 1 argumento solo resuelve la membresía del propio current_user_id()', async () => {
    const orgA = await seedOrg(db, 'db01-org-b');
    const orgB = await seedOrg(db, 'db01-org-c');
    const ownerA = await seedMember(db, orgA.orgId, 'db01-owner-a@example.com', 'owner');
    await seedMember(db, orgB.orgId, 'db01-owner-b@example.com', 'admin');

    // El actor (ownerA) consulta SU PROPIA membresía en orgA: debe verla.
    const own = await asActor(db, { userId: ownerA }, (tx) =>
      tx.query<{ role: string | null }>('select app.membership_role($1) as role', [orgA.orgId])
    );
    expect(own.rows[0]?.role).toBe('owner');

    // El mismo actor intenta resolver la membresía de orgB, donde NO tiene
    // relación alguna (es ownerA de orgA, no miembro de orgB): debe ver NULL,
    // nunca el rol real del owner/admin de orgB.
    const foreign = await asActor(db, { userId: ownerA }, (tx) =>
      tx.query<{ role: string | null }>('select app.membership_role($1) as role', [orgB.orgId])
    );
    expect(foreign.rows[0]?.role).toBeNull();
  });

  it('app.find_user_by_email rechaza ejecutarse si ya hay un current_user_id de sesión fijado', async () => {
    await seedUser(db, 'db01-victim@example.com');
    const attacker = await seedUser(db, 'db01-attacker2@example.com');

    // Sesión "post-login" real: el atacante ya está autenticado (tiene
    // current_user_id fijado) e intenta usar find_user_by_email como si
    // fuera una función de búsqueda general para robar el password_hash de
    // otro usuario. Debe fallar explícitamente.
    await expect(
      asActor(db, { userId: attacker }, (tx) => tx.query('select * from app.find_user_by_email($1)', ['db01-victim@example.com']))
    ).rejects.toThrow(/find_user_by_email_not_allowed_in_session_context/);
  });

  it('app.find_user_by_email sigue funcionando en contexto pre-sesión (login real, sin current_user_id fijado)', async () => {
    await seedUser(db, 'db01-legit-login@example.com');

    const result = await asActor(db, {}, (tx) =>
      tx.query<{ id: string; password_hash: string; is_active: boolean }>(
        'select * from app.find_user_by_email($1)',
        ['db01-legit-login@example.com']
      )
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].is_active).toBe(true);
  });
});
