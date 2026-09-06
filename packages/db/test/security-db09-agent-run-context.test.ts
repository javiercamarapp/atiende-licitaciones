import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, asActor } from './helpers.js';

/**
 * DB-09 (docs/auditoria-1/db-api-reverificacion.md, BAJA) --
 * `app.agent_run_context` es SECURITY DEFINER y resolvía `org_id`/`actor_id`
 * de cualquier `agent_run` por UUID sin validar el llamador. Mitigado
 * PARCIALMENTE en 0044_fix_db09_agent_run_context_bootstrap_guard.sql
 * (mismo patrón "pre-sesión" que `app.find_user_by_email`, DB-01/0019): se
 * rechaza si ya hay contexto de sesión fijado.
 *
 * Gap residual documentado en 0044: una llamada SIN contexto de sesión
 * (igual que el llamador legítimo, `apps/api/src/lib/agent-stores.pg.ts`)
 * sigue resolviendo la corrida -- cerrarlo del todo requiere que ese
 * archivo pase la identidad autenticada como parámetro, y ese archivo está
 * fuera del ámbito de este agente. Este test documenta ambos hechos: lo que
 * SÍ se cerró y lo que sigue abierto, sin afirmar más de lo que es cierto.
 */
describe('DB-09: app.agent_run_context rechaza uso con sesión ya autenticada (mitigación parcial)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('una sesión YA autenticada (current_user_id fijado) no puede usar agent_run_context como oráculo de otra corrida', async () => {
    const org = await seedOrg(db, 'db09-org-victim');
    const { rows } = await db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_name) values ($1, 'victim-agent') returning id",
      [org.orgId]
    );
    const runId = rows[0].id;

    await expect(
      asActor(db, { userId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }, (tx) =>
        tx.query('select * from app.agent_run_context($1)', [runId])
      )
    ).rejects.toThrow(/agent_run_context_not_allowed_in_session_context/);
  });

  it('gap residual documentado: sin contexto de sesión previo (mismo patrón que el llamador legítimo), sigue resolviendo cualquier run_id', async () => {
    const org = await seedOrg(db, 'db09-org-victim2');
    const { rows } = await db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_name) values ($1, 'victim-agent-2') returning id",
      [org.orgId]
    );
    const runId = rows[0].id;

    // `set local role app_role` SIN fijar `app.current_user_id`/`current_org_id`
    // -- exactamente la forma en que apps/api/src/lib/agent-stores.pg.ts
    // (`resolveContext`/`listToolCalls`) la invoca hoy. El cierre completo
    // de este hueco requiere pasar la identidad del actor autenticado como
    // parámetro desde ese archivo (fuera del ámbito de este agente).
    const result = await db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ org_id: string; actor_id: string | null }>('select * from app.agent_run_context($1)', [
        runId,
      ]);
    });
    expect(result.rows[0]?.org_id).toBe(org.orgId);
  });
});
