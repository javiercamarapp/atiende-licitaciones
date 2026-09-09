import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedUser, asActor } from './helpers.js';

/**
 * REQ-177 (docs/ACEPTACION.md): brecha honesta detectada por el auditor --
 * `app.record_auth_event` (0051, extendida en 0054/0072/0084/0092/0093)
 * nunca aceptaba un `correlation_id`, así que `audit_log.correlation_id`
 * quedaba SIEMPRE NULL para todo evento de autenticación -- con paridad
 * exacta entre Google y email+contraseña (ninguno de los dos lo llenaba).
 *
 * Cerrado en 0096_req177_auth_event_correlation_id.sql: `p_correlation_id`
 * nuevo, quinto parámetro con DEFAULT null (nunca una sobrecarga aparte --
 * se hizo `drop function` de la firma de 4 argumentos primero, mismo
 * patrón que 0085/0092 al cambiar la firma de una función SECURITY
 * DEFINER existente) -- así que cualquier llamador SQL directo con los 4
 * argumentos posicionales de siempre (incl. TODAS las pruebas existentes
 * de este mismo directorio, ver security-api14-auth-audit-actor-match.test.ts
 * y req172-google-oidc.test.ts) sigue funcionando sin cambios, insertando
 * `correlation_id = null` como antes.
 */
describe('REQ-177: app.record_auth_event persiste correlation_id (0096)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('con el 5º argumento, correlation_id queda en audit_log tal cual se mandó', async () => {
    const userId = await seedUser(db, 'req177-with-correlation@example.com');
    const correlationId = '33333333-3333-4333-8333-333333333333';

    await asActor(db, { userId }, (tx) =>
      tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4, $5)', ['auth.login_succeeded', userId, '{}', 'req-177-a', correlationId])
    );

    const rows = await db.query<{ correlation_id: string | null }>(
      'select correlation_id from audit_log where actor_id = $1 and action = $2',
      [userId, 'auth.login_succeeded']
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].correlation_id).toBe(correlationId);
  });

  it('RETROCOMPATIBILIDAD: la llamada histórica de 4 argumentos (sin correlation_id) sigue funcionando -- inserta correlation_id = null', async () => {
    const userId = await seedUser(db, 'req177-legacy-4-args@example.com');

    await asActor(db, { userId }, (tx) => tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', ['auth.login_succeeded', userId, '{}', 'req-177-b']));

    const rows = await db.query<{ correlation_id: string | null }>(
      'select correlation_id from audit_log where actor_id = $1 and action = $2',
      [userId, 'auth.login_succeeded']
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].correlation_id).toBeNull();
  });

  it('correlation_id = null explícito (5º argumento) también es válido -- nunca exige un valor', async () => {
    const userId = await seedUser(db, 'req177-explicit-null@example.com');

    await asActor(db, { userId }, (tx) =>
      tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4, $5)', ['auth.login_succeeded', userId, '{}', 'req-177-c', null])
    );

    const rows = await db.query<{ correlation_id: string | null }>(
      'select correlation_id from audit_log where actor_id = $1 and action = $2',
      [userId, 'auth.login_succeeded']
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].correlation_id).toBeNull();
  });

  it('el resto de las reglas de app.record_auth_event (acción permitida, actor coincidente) siguen aplicando igual con correlation_id presente', async () => {
    const attackerId = await seedUser(db, 'req177-attacker@example.com');
    const victimId = await seedUser(db, 'req177-victim@example.com');

    await expect(
      asActor(db, { userId: attackerId }, (tx) =>
        tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4, $5)', ['auth.login_succeeded', victimId, '{}', 'req-177-d', 'some-correlation-id'])
      )
    ).rejects.toThrow(/record_auth_event_actor_mismatch/);

    await expect(
      asActor(db, { userId: attackerId }, (tx) =>
        tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4, $5)', ['auth.algo_inventado', attackerId, '{}', 'req-177-e', 'some-correlation-id'])
      )
    ).rejects.toThrow(/record_auth_event_accion_no_permitida/);
  });
});
