import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedUser, asActor } from './helpers.js';

/**
 * API-14 (docs/auditoria-2/api-expediente-reverificacion.md, BAJA/MEDIA):
 * `app.record_auth_event` (0051) aceptaba `p_actor_id` sin validarlo contra
 * `app.current_user_id()` -- cualquier código corriendo como `app_role`
 * podía forjar un evento de auditoría de autenticación atribuido a un
 * `actor_id` arbitrario. 0054 exige que coincida con la identidad de
 * sesión YA fijada por el llamador, salvo `auth.login_failed` (el único
 * evento genuinamente pre-autenticación).
 */
describe('API-14: app.record_auth_event exige que el actor coincida con la sesión (salvo login_failed)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('ATAQUE: un actor NO puede forjar auth.login_succeeded atribuido a OTRO usuario', async () => {
    const attackerId = await seedUser(db, 'api14-attacker@example.com');
    const victimId = await seedUser(db, 'api14-victim@example.com');

    await expect(
      asActor(db, { userId: attackerId }, (tx) =>
        tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', ['auth.login_succeeded', victimId, '{}', 'fake-req'])
      )
    ).rejects.toThrow(/record_auth_event_actor_mismatch/);

    const rows = await db.query('select 1 from audit_log where actor_id = $1 and action = $2', [victimId, 'auth.login_succeeded']);
    expect(rows.rows.length).toBe(0);
  });

  it('ATAQUE: tampoco puede forjar auth.logout ni auth.refresh_succeeded/refresh_reuse_detected para otro usuario', async () => {
    const attackerId = await seedUser(db, 'api14-attacker-2@example.com');
    const victimId = await seedUser(db, 'api14-victim-2@example.com');

    for (const action of ['auth.logout', 'auth.refresh_succeeded', 'auth.refresh_reuse_detected']) {
      await expect(
        asActor(db, { userId: attackerId }, (tx) => tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', [action, victimId, '{}', 'fake-req']))
      ).rejects.toThrow(/record_auth_event_actor_mismatch/);
    }
  });

  it('un actor SÍ puede registrar un evento (no login_failed) atribuido a SÍ MISMO', async () => {
    const userId = await seedUser(db, 'api14-self@example.com');
    await asActor(db, { userId }, (tx) => tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', ['auth.login_succeeded', userId, '{}', 'req-1']));
    const rows = await db.query('select 1 from audit_log where actor_id = $1 and action = $2', [userId, 'auth.login_succeeded']);
    expect(rows.rows.length).toBe(1);
  });

  it('sin ninguna sesión fijada (app.current_user_id() null), auth.login_succeeded/logout/refresh_* fallan igual (nunca "abierto" por falta de contexto)', async () => {
    const someUserId = await seedUser(db, 'api14-nosession@example.com');
    await expect(
      db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        return tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', ['auth.login_succeeded', someUserId, '{}', 'req']);
      })
    ).rejects.toThrow(/record_auth_event_actor_mismatch/);
  });

  it('auth.login_failed SIGUE funcionando sin sesión previa (evento genuinamente pre-autenticación), con actor_id de la cuenta cuya contraseña falló', async () => {
    const someUserId = await seedUser(db, 'api14-loginfailed@example.com');
    await db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', ['auth.login_failed', someUserId, '{}', 'req-lf']);
    });
    const rows = await db.query('select 1 from audit_log where actor_id = $1 and action = $2', [someUserId, 'auth.login_failed']);
    expect(rows.rows.length).toBe(1);
  });

  it('auth.login_failed también funciona con actor_id NULL (email inexistente, sin ninguna cuenta real detrás)', async () => {
    await db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', ['auth.login_failed', null, '{}', 'req-lf-null']);
    });
    const rows = await db.query("select 1 from audit_log where actor_id is null and action = 'auth.login_failed'");
    expect(rows.rows.length).toBeGreaterThan(0);
  });
});
