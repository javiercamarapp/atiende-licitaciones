import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient, DbExecutor } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember } from './helpers.js';

/**
 * Cubre las 3 propuestas de apps/worker/db-proposals/ incorporadas a
 * packages/db en esta ronda (WK-04/WK-07/WK-08, ver
 * packages/db/migrations/0026-0028). Los `.pending.test.ts` de apps/worker
 * describen el comportamiento esperado desde el punto de vista de esa app;
 * estas pruebas verifican el mismo comportamiento a nivel de esquema/RLS,
 * que es lo que corresponde a packages/db.
 */

async function runAsWorkerRole<T>(db: DbClient, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role worker_role');
    return fn(tx);
  });
}

describe('PROPOSAL-01 (WK-07): source_run_status ampliado', () => {
  let db: DbClient;
  beforeAll(async () => {
    db = await createMigratedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('rate_limited, not_configured e ingest_failed se persisten como su propio valor, no como failed', async () => {
    for (const status of ['rate_limited', 'not_configured', 'ingest_failed']) {
      const { rows } = await db.query<{ status: string }>(
        'insert into source_runs (source_id, status) values ($1, $2) returning status',
        [`test-source-${status}`, status]
      );
      expect(rows[0].status).toBe(status);
    }
  });
});

describe('PROPOSAL-02 (WK-04): índice único de jobs activos + estado cancelled', () => {
  let db: DbClient;
  beforeAll(async () => {
    db = await createMigratedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('un segundo INSERT directo con la misma (kind, jobKey) activa viola el índice único (23505)', async () => {
    await db.query("insert into jobs (kind, payload, status) values ('discover_tenders', '{\"jobKey\": \"compras-mx-2026-09-05\"}'::jsonb, 'queued')");
    await expect(
      db.query("insert into jobs (kind, payload, status) values ('discover_tenders', '{\"jobKey\": \"compras-mx-2026-09-05\"}'::jsonb, 'queued')")
    ).rejects.toThrow();
  });

  it('la misma (kind, jobKey) puede reutilizarse una vez el job anterior ya no está activo (succeeded/dead/cancelled)', async () => {
    const { rows } = await db.query<{ id: string }>(
      "insert into jobs (kind, payload, status) values ('discover_tenders', '{\"jobKey\": \"reuse-key\"}'::jsonb, 'queued') returning id"
    );
    await db.query("update jobs set status = 'succeeded' where id = $1", [rows[0].id]);
    const second = await db.query(
      "insert into jobs (kind, payload, status) values ('discover_tenders', '{\"jobKey\": \"reuse-key\"}'::jsonb, 'queued') returning id"
    );
    expect(second.rows.length).toBe(1);
  });

  it("acepta el estado 'cancelled', distinguible de 'dead' sin leer last_error", async () => {
    const { rows } = await db.query<{ status: string }>(
      "insert into jobs (kind, status) values ('discover_tenders', 'cancelled') returning status"
    );
    expect(rows[0].status).toBe('cancelled');
  });
});

describe('PROPOSAL-03 (WK-08): worker_role con RLS real', () => {
  let db: DbClient;
  beforeAll(async () => {
    db = await createMigratedDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it('worker_role tiene EXACTAMENTE grants sobre {jobs, source_runs, agent_runs}, ninguna otra tabla', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `select distinct table_name from information_schema.role_table_grants
       where grantee = 'worker_role' order by table_name`
    );
    const tables = rows.map((r) => r.table_name).sort();
    expect(tables).toEqual(['agent_runs', 'jobs', 'source_runs']);
  });

  it('worker_role puede ver/crear jobs de PLATAFORMA (org_id NULL), no solo los de una organización', async () => {
    await db.query("insert into jobs (org_id, kind) values (null, 'discover_tenders')");
    const seen = await runAsWorkerRole(db, (tx) => tx.query("select id from jobs where kind = 'discover_tenders' and org_id is null"));
    expect(seen.rows.length).toBeGreaterThan(0);

    const inserted = await runAsWorkerRole(db, (tx) =>
      tx.query("insert into jobs (org_id, kind) values (null, 'discover_tenders') returning id")
    );
    expect(inserted.rows.length).toBe(1);
  });

  it('worker_role puede leer/escribir source_runs sin ser superadmin', async () => {
    const inserted = await runAsWorkerRole(db, (tx) =>
      tx.query("insert into source_runs (source_id, status) values ('worker-role-test', 'ok') returning id")
    );
    expect(inserted.rows.length).toBe(1);

    const seen = await runAsWorkerRole(db, (tx) => tx.query("select id from source_runs where source_id = 'worker-role-test'"));
    expect(seen.rows.length).toBe(1);
  });

  it('ATAQUE: worker_role nunca ve una fila real de tablas de datos de tenant fuera de su caso de uso (tenders, company_profiles, proposals, users, memberships)', async () => {
    // worker_role hereda `app_role` (grant app_role to worker_role), que a
    // su vez tiene el privilegio de tabla por defecto de 0001 (`alter
    // default privileges ... grant select ... on tables to app_role`) sobre
    // TODO el esquema -- igual que cualquier conexión app_role. La defensa
    // real nunca fue "GRANT a nivel de tabla" (eso lo comparte con toda la
    // API), sino RLS: sin `app.current_org_id()`/`app.current_user_id()`
    // fijados a una organización/membresía real, la política de cada tabla
    // oculta TODAS las filas. Por eso la aserción correcta es "cero filas
    // devueltas", no un error de permiso de tabla -- es la misma garantía
    // que ya protege a cualquier conexión app_role sin contexto (ver
    // rls-isolation.test.ts, caso "sin contexto de sesión").
    const org = await seedOrg(db, 'worker-role-attack-org');
    await db.query("insert into tenders (org_id, source, external_id, title) values ($1, 'test', 'wr-1', 'X')", [org.orgId]);
    await db.query("insert into company_profiles (org_id, legal_name) values ($1, 'Empresa X')", [org.orgId]);
    const ownerId = await seedMember(db, org.orgId, 'worker-attack-owner@example.com', 'owner');

    for (const table of ['tenders', 'company_profiles', 'proposals']) {
      const result = await runAsWorkerRole(db, (tx) => tx.query(`select * from ${table}`));
      expect(result.rows.length).toBe(0);
    }

    // `users`/`memberships` tienen su propia política (no basada en
    // org_id/has_role): un `select *` sin `current_user_id()` fijado
    // tampoco expone ninguna fila real a worker_role.
    const usersResult = await runAsWorkerRole(db, (tx) => tx.query('select * from users where id = $1', [ownerId]));
    expect(usersResult.rows.length).toBe(0);
    const membershipsResult = await runAsWorkerRole(db, (tx) => tx.query('select * from memberships where org_id = $1', [org.orgId]));
    expect(membershipsResult.rows.length).toBe(0);
  });

  it('ATAQUE: worker_role con app.current_org_id de la org A no puede actualizar una fila agent_runs de la org B, aun sin filtro explícito de org_id en la query', async () => {
    const orgA = await seedOrg(db, 'worker-role-agent-a');
    const orgB = await seedOrg(db, 'worker-role-agent-b');
    const actorA = await seedMember(db, orgA.orgId, 'worker-actor-a@example.com', 'writer');
    await seedMember(db, orgB.orgId, 'worker-actor-b@example.com', 'writer');

    const { rows: runB } = await db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_name) values ($1, 'redactor') returning id",
      [orgB.orgId]
    );

    const updated = await db.transaction(async (tx) => {
      await tx.query('set local role worker_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [orgA.orgId]);
      await tx.query("select set_config('app.current_user_id', $1, true)", [actorA]);
      // A propósito SIN filtro de org_id en el WHERE: la defensa real debe
      // venir de RLS, no de que la query "se acuerde" de filtrar.
      return tx.query("update agent_runs set status = 'succeeded' where id = $1", [runB[0].id]);
    });
    expect(updated.rowCount).toBe(0);

    const stillRunning = await db.query<{ status: string }>('select status from agent_runs where id = $1', [runB[0].id]);
    expect(stillRunning.rows[0].status).toBe('running');
  });

  it('worker_role SÍ puede actualizar una corrida de SU PROPIA organización cuando fija el contexto del actor real', async () => {
    const org = await seedOrg(db, 'worker-role-agent-own');
    const actor = await seedMember(db, org.orgId, 'worker-actor-own@example.com', 'writer');
    const { rows } = await db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_name) values ($1, 'redactor') returning id",
      [org.orgId]
    );

    const updated = await db.transaction(async (tx) => {
      await tx.query('set local role worker_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [org.orgId]);
      await tx.query("select set_config('app.current_user_id', $1, true)", [actor]);
      return tx.query("update agent_runs set status = 'succeeded' where id = $1", [rows[0].id]);
    });
    expect(updated.rowCount).toBe(1);
  });

  it('worker_role está NOLOGIN: no se puede conectar directamente con credenciales (solo alcanzable vía SET ROLE desde una conexión con privilegios)', async () => {
    const { rows } = await db.query<{ rolcanlogin: boolean }>("select rolcanlogin from pg_roles where rolname = 'worker_role'");
    expect(rows[0].rolcanlogin).toBe(false);
  });
});
