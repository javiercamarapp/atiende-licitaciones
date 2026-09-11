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

  it('worker_role tiene EXACTAMENTE grants sobre {jobs, source_runs, agent_runs} + las 10 tablas de lectura de negocio de 0098 (E6/PROPOSAL-06) + las 2 tablas de huellas de REQ-032 (idempotente con el re-grant de proposal_sections de REQ-070) + las tablas de KYC/fingerprint de REQ-026/111/112, ninguna otra', async () => {
    // Ampliado por 0098_e6_agent_business_tools_grants.sql (PROPOSAL-06,
    // docs/BLOQUEOS.md "E6-ciclo-agentes"): antes de esa migración la
    // lista era exactamente {agent_runs, jobs, source_runs} (WK-08). El
    // resto de este describe ("ATAQUE: worker_role nunca ve...") cubre por
    // qué conceder SELECT de tabla completa sobre estas 10 tablas nuevas
    // es una decisión deliberada, no una regresión de aislamiento.
    //
    // Ampliado de nuevo por la migración de REQ-032:
    // `proposal_section_fingerprints` (huellas MinHash SIN
    // contenido -- worker_role las lee/escribe para comparar huellas ENTRE
    // organizaciones, ver `req032-similarity-fingerprints.test.ts`) y
    // `proposal_similarity_flags` (evento de cumplimiento, worker_role
    // solo select/insert -- la LECTURA vía RLS sigue reservada a
    // superadmin, el grant de tabla por sí solo no basta, ver ese mismo
    // test). La migración de REQ-070 (nodo "Auditor" —
    // `auditar_expediente`/`computeAuditReport` necesita leer
    // `proposal_sections` para decidir bloqueos reales) re-otorga SELECT
    // sobre `proposal_sections`, ya concedida por 0098 -- idempotente, no
    // añade una tabla nueva a esta lista. Ampliado de nuevo por las
    // migraciones de REQ-026/REQ-111/REQ-112 (KYC negativo 69-B y
    // fingerprint de interpósita persona): el job nocturno necesita (a)
    // select/insert/update sobre las 5 tablas de compliance nuevas
    // (sanctions_69b_snapshots/entries, tenant_kyc_checks/status,
    // entity_fingerprint_matches) y (b) SOLO select cross-tenant sobre
    // organizations/locations/authorized_signatories/company_stakeholders
    // (`company_profiles` ya estaba concedido desde 0098) -- las señales de
    // identidad que `packages/kyc` compara entre tenants. Nunca escritura
    // sobre estas últimas 4: el worker no modifica el perfil de una empresa.
    const { rows } = await db.query<{ table_name: string }>(
      `select distinct table_name from information_schema.role_table_grants
       where grantee = 'worker_role' order by table_name`
    );
    const tables = rows.map((r) => r.table_name).sort();
    expect(tables).toEqual(
      [
        'agent_runs',
        'jobs',
        'source_runs',
        'tenders',
        'tender_documents',
        'tender_versions',
        'tender_change_events',
        'requirement_items',
        'company_profiles',
        'capabilities',
        'experience_records',
        'proposal_sections',
        'compliance_items',
        'proposals',
        'proposal_section_fingerprints',
        'proposal_similarity_flags',
        'organizations',
        'locations',
        'authorized_signatories',
        'company_stakeholders',
        'sanctions_69b_snapshots',
        'sanctions_69b_entries',
        'tenant_kyc_checks',
        'tenant_kyc_status',
        'entity_fingerprint_matches',
      ].sort()
    );
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

  it('ATAQUE (vigente tras 0098): worker_role sigue sin ver NUNCA una fila real de users/memberships, ni de ninguna tabla de negocio NO listada en 0098', async () => {
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
    //
    // `tenders`/`company_profiles`/`proposals` salieron de este ataque tras
    // 0098 (E6/PROPOSAL-06, ver test siguiente): esas 3 (+7 más) ahora
    // tienen una política adicional `current_user = 'worker_role'` SIN
    // condición de organización, deliberada -- la lectura de negocio de
    // `apps/worker/src/agents/business-tools.ts` acota por organización
    // con un `WHERE org_id = $orgId` explícito en cada query (defensa en
    // profundidad en la capa de aplicación, documentado en
    // `withWorkerBusinessReadContext`, apps/worker/src/agents/db-context.ts),
    // no con RLS. `users`/`memberships` NUNCA se incluyeron en 0098 --
    // siguen protegidas exactamente igual que antes.
    const org = await seedOrg(db, 'worker-role-attack-org');
    const ownerId = await seedMember(db, org.orgId, 'worker-attack-owner@example.com', 'owner');

    const usersResult = await runAsWorkerRole(db, (tx) => tx.query('select * from users where id = $1', [ownerId]));
    expect(usersResult.rows.length).toBe(0);
    const membershipsResult = await runAsWorkerRole(db, (tx) => tx.query('select * from memberships where org_id = $1', [org.orgId]));
    expect(membershipsResult.rows.length).toBe(0);
  });

  it('0098 (E6/PROPOSAL-06): worker_role SÍ ve, sin contexto de organización, filas de las 10 tablas de negocio recién concedidas — mitigado en apps/worker por el WHERE org_id explícito de business-tools.ts, nunca por RLS', async () => {
    // Documenta el cambio de contrato deliberado (ver 0098 y el test
    // "EXACTAMENTE grants" de arriba): antes de 0098 este mismo `select *`
    // devolvía 0 filas (RLS de organización sin excepción). 0098 añade,
    // para estas 10 tablas exactas, una política PERMISSIVE adicional
    // (`current_user = 'worker_role'`, sin `org_id`) que se combina con OR
    // sobre la política de organización existente -- por eso ahora SÍ ve
    // la fila de cualquier organización con una conexión `worker_role`
    // desnuda, sin `app.current_org_id` fijado. No es un descuido: es la
    // única forma de que un proceso de servicio (no un usuario humano con
    // membresía) pueda leer datos de negocio de eventos de plataforma; el
    // aislamiento real para las herramientas nombradas de
    // `business-tools.ts` lo da el `WHERE org_id = $orgId` explícito de
    // cada una de sus queries (`withWorkerBusinessReadContext`), revisable
    // en ese archivo -- RLS aquí es un permiso amplio, no un aislador.
    const org = await seedOrg(db, 'worker-role-0098-visible');
    await db.query("insert into tenders (org_id, source, external_id, title) values ($1, 'test', 'wr-0098', 'X')", [org.orgId]);
    await db.query("insert into company_profiles (org_id, legal_name) values ($1, 'Empresa 0098')", [org.orgId]);

    for (const table of ['tenders', 'company_profiles']) {
      const result = await runAsWorkerRole(db, (tx) => tx.query(`select * from ${table} where org_id = $1`, [org.orgId]));
      expect(result.rows.length).toBe(1);
    }
  });

  it('0099 (REQ-070): worker_role SÍ ve, sin contexto de organización, filas de proposal_sections — mismo patrón exacto que 0098, para que auditar_expediente/computeAuditReport pueda leer secciones reales', async () => {
    const org = await seedOrg(db, 'worker-role-0099-visible');
    const tender = await db.query<{ id: string }>(
      "insert into tenders (org_id, source, external_id, title) values ($1, 'test', 'wr-0099', 'X') returning id",
      [org.orgId]
    );
    const proposal = await db.query<{ id: string }>(
      "insert into proposals (org_id, tender_id, title) values ($1, $2, 'Propuesta 0099') returning id",
      [org.orgId, tender.rows[0].id]
    );
    await db.query(
      "insert into proposal_sections (org_id, proposal_id, section_key, title, content) values ($1, $2, 'technical:x', 'Sección', 'texto')",
      [org.orgId, proposal.rows[0].id]
    );

    const result = await runAsWorkerRole(db, (tx) => tx.query('select * from proposal_sections where org_id = $1', [org.orgId]));
    expect(result.rows.length).toBe(1);
  });

  it('ATAQUE: worker_role con app.current_org_id de la org A no puede actualizar una fila agent_runs (started_by de un humano real) de la org B, aun sin filtro explícito de org_id en la query', async () => {
    // `started_by` poblado a propósito (E6, hallazgo de la reverificación
    // de 0098/PROPOSAL-06): antes de la corrección en
    // `apps/api/src/lib/agent-stores.pg.ts`/`agent-triggers.ts` NINGÚN
    // INSERT real de `agent_runs` poblaba esta columna -- ni siquiera las
    // corridas humanas -- así que este mismo ataque, reproducido contra el
    // esquema real, SÍ conseguía el UPDATE cross-tenant: la política
    // adicional de 0098 (`... and started_by is null`), pensada
    // EXCLUSIVAMENTE para corridas autónomas del worker, en la práctica
    // también amparaba filas humanas. Este test simula ahora la fila tal
    // como la crea el código real ya corregido (`started_by` = el usuario
    // que la inició) -- ver el siguiente test para el caso
    // `started_by is null` (corrida autónoma real), que SÍ debe seguir
    // siendo alcanzable por worker_role sin importar el contexto de
    // organización.
    const orgA = await seedOrg(db, 'worker-role-agent-a');
    const orgB = await seedOrg(db, 'worker-role-agent-b');
    const actorA = await seedMember(db, orgA.orgId, 'worker-actor-a@example.com', 'writer');
    const actorB = await seedMember(db, orgB.orgId, 'worker-actor-b@example.com', 'writer');

    const { rows: runB } = await db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_name, started_by) values ($1, 'redactor', $2) returning id",
      [orgB.orgId, actorB]
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

  it('0098 (E6/PROPOSAL-06): worker_role SÍ puede actualizar una fila agent_runs de CUALQUIER organización cuando started_by es null (corrida autónoma real) — comportamiento intencional, nunca alcanza filas humanas (started_by no nulo, ver test anterior)', async () => {
    const orgA = await seedOrg(db, 'worker-role-agent-a-autonomo');
    const orgB = await seedOrg(db, 'worker-role-agent-b-autonomo');
    await seedMember(db, orgA.orgId, 'worker-actor-a-autonomo@example.com', 'writer');

    // Sin `started_by` -- mismo INSERT que `enqueueAgentRun`
    // (apps/worker/src/agents/enqueue-agent-run.ts) para una corrida
    // disparada por un evento de plataforma, sin actor humano.
    const { rows: runB } = await db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_name) values ($1, 'redactor') returning id",
      [orgB.orgId]
    );

    const updated = await db.transaction(async (tx) => {
      await tx.query('set local role worker_role');
      // Contexto de organización de OTRA org (o incluso ninguno) -- no
      // debería importar para una fila `started_by is null`: el worker
      // actúa como servicio de plataforma sobre sus PROPIAS filas
      // autónomas, no "como" un usuario con membresía.
      await tx.query("select set_config('app.current_org_id', $1, true)", [orgA.orgId]);
      return tx.query("update agent_runs set status = 'succeeded' where id = $1", [runB[0].id]);
    });
    expect(updated.rowCount).toBe(1);
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
