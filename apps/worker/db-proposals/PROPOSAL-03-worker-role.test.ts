import { describe, it, expect } from 'vitest';
import type { DbClient, DbExecutor } from '@atiende/db';
import { createMigratedDb, seedOrgAndUser, seedMember } from '../test/helpers.js';

/**
 * WK-22 (docs/auditoria-1/worker-cierre.md, ALTA): activa los tests que
 * acompañaban a `PROPOSAL-03-worker-role.sql` (WK-08).
 * `packages/db/migrations/0028_worker_role.sql` ya está aplicada (rol
 * `worker_role`, grants exactos sobre jobs/source_runs/agent_runs, RLS
 * real). `packages/db/test/worker-role-and-job-proposals.test.ts` (fuera
 * de este ámbito) ya cubre el esquema/RLS en sí con más profundidad; este
 * archivo cubre el mismo contrato desde el punto de vista de `apps/worker`
 * (helpers/estilo propios de este paquete), más el caso específico de
 * WK-23 (identidad de servicio real bajo `worker_role` para
 * `agent_runs`), que ya tiene su propia cobertura de extremo a extremo en
 * `test/run-agent-handler.test.ts` (a través de `updateAgentRunRow`, que
 * ahora adopta `worker_role` de verdad).
 */
async function runAsWorkerRole<T>(db: DbClient, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role worker_role');
    return fn(tx);
  });
}

describe('PROPOSAL-03 (WK-08/WK-22/WK-23): worker_role con RLS real', () => {
  it('worker_role existe y está NOLOGIN (solo alcanzable vía SET ROLE desde una conexión con privilegios)', async () => {
    const db = await createMigratedDb();
    try {
      const { rows } = await db.query<{ rolname: string; rolcanlogin: boolean }>(
        "select rolname, rolcanlogin from pg_roles where rolname = 'worker_role'",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].rolcanlogin).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('worker_role tiene EXACTAMENTE grants sobre {jobs, source_runs, agent_runs} + las 10 tablas de lectura de negocio de 0098 (E6/PROPOSAL-06) + las 2 tablas de huellas de REQ-032 + proposal_sections de REQ-070 + las tablas de KYC/fingerprint de REQ-026/111/112, ninguna otra', async () => {
    // Ampliado por packages/db/migrations/0098_e6_agent_business_tools_grants.sql
    // (E6, docs/BLOQUEOS.md "E6-ciclo-agentes"), por la migración de
    // REQ-032 (proposal_section_fingerprints/proposal_similarity_flags), por
    // la migración de REQ-070 (proposal_sections, nodo "Auditor" —
    // `auditar_expediente`/`computeAuditReport` necesita leerla) y por las
    // migraciones de REQ-026/REQ-111/REQ-112 (KYC negativo 69-B y
    // fingerprint de interpósita persona) — ver
    // packages/db/test/worker-role-and-job-proposals.test.ts para el mismo
    // contrato con más profundidad (incluida la razón de negocio de cada
    // tabla añadida).
    const db = await createMigratedDb();
    try {
      const { rows } = await db.query<{ table_name: string }>(
        `select distinct table_name from information_schema.role_table_grants
         where grantee = 'worker_role' order by table_name`,
      );
      expect(rows.map((r) => r.table_name).sort()).toEqual(
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
          'compliance_items',
          'proposals',
          'proposal_section_fingerprints',
          'proposal_similarity_flags',
          'proposal_sections',
          'organizations',
          'locations',
          'authorized_signatories',
          'company_stakeholders',
          'sanctions_69b_snapshots',
          'sanctions_69b_entries',
          'tenant_kyc_checks',
          'tenant_kyc_status',
          'entity_fingerprint_matches',
        ].sort(),
      );
    } finally {
      await db.close();
    }
  });

  it('worker_role puede ver/crear jobs de PLATAFORMA (org_id NULL)', async () => {
    const db = await createMigratedDb();
    try {
      await db.query("insert into jobs (org_id, kind) values (null, 'discover_tenders')");
      const seen = await runAsWorkerRole(db, (tx) =>
        tx.query("select id from jobs where kind = 'discover_tenders' and org_id is null"),
      );
      expect(seen.rows.length).toBeGreaterThan(0);
    } finally {
      await db.close();
    }
  });

  it('worker_role puede leer/escribir source_runs sin ser superadmin', async () => {
    const db = await createMigratedDb();
    try {
      const inserted = await runAsWorkerRole(db, (tx) =>
        tx.query("insert into source_runs (source_id, status) values ('worker-role-test-apps-worker', 'ok') returning id"),
      );
      expect(inserted.rows.length).toBe(1);
    } finally {
      await db.close();
    }
  });

  /**
   * WK-23: ataque explícito pedido por el encargo — organizationId
   * correcto (`org_id = current_org_id()`), pero SIN `app.current_user_id`
   * fijado (el bug real de `updateAgentRunRow` antes de esta ronda). RLS
   * debe bloquear incluso una fila LEGÍTIMA del tenant correcto.
   *
   * `started_by` poblado a propósito (E6, hallazgo de la reverificación de
   * 0098/PROPOSAL-06, ver `packages/db/test/worker-role-and-job-proposals.test.ts`
   * para el mismo hallazgo con más detalle): esta fila representa una
   * corrida HUMANA real (igual que la crean hoy `agent-stores.pg.ts`/
   * `agent-triggers.ts`) -- sin esto, la política adicional de 0098 sobre
   * `agent_runs` (`... and started_by is null`) también autorizaba este
   * UPDATE, ocultando el bloqueo real de RLS que este test verifica.
   */
  it('WK-23: worker_role con org_id correcto pero SIN current_user_id fijado no puede actualizar agent_runs (ni siquiera su propio tenant)', async () => {
    const db = await createMigratedDb();
    try {
      const { orgId, userId } = await seedOrgAndUser(db, 'wk23-proposal03-noactor');
      const { rows } = await db.query<{ id: string }>(
        "insert into agent_runs (org_id, agent_name, started_by) values ($1, 'redactor', $2) returning id",
        [orgId, userId],
      );
      const runId = rows[0].id;

      const updated = await db.transaction(async (tx) => {
        await tx.query('set local role worker_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        // Deliberadamente SIN fijar app.current_user_id (el bug real
        // pre-WK-23 de updateAgentRunRow).
        return tx.query("update agent_runs set status = 'succeeded' where id = $1", [runId]);
      });
      expect(updated.rowCount).toBe(0);

      const after = await db.query<{ status: string }>('select status from agent_runs where id = $1', [runId]);
      expect(after.rows[0].status).toBe('running');
    } finally {
      await db.close();
    }
  });

  /**
   * WK-23: con org_id Y current_user_id (actor real, con membresía de
   * escritura activa) correctos, el UPDATE legítimo SÍ funciona.
   */
  it('WK-23: worker_role con org_id y current_user_id (actor real) correctos SÍ actualiza agent_runs de su propio tenant', async () => {
    const db = await createMigratedDb();
    try {
      const { orgId } = await seedOrgAndUser(db, 'wk23-proposal03-withactor');
      const actorId = await seedMember(db, orgId, 'wk23-proposal03-actor@example.test', 'writer');
      const { rows } = await db.query<{ id: string }>(
        "insert into agent_runs (org_id, agent_name) values ($1, 'redactor') returning id",
        [orgId],
      );
      const runId = rows[0].id;

      const updated = await db.transaction(async (tx) => {
        await tx.query('set local role worker_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [actorId]);
        return tx.query("update agent_runs set status = 'succeeded' where id = $1", [runId]);
      });
      expect(updated.rowCount).toBe(1);
    } finally {
      await db.close();
    }
  });

  /**
   * ATAQUE cross-tenant: org_id de la org A, fila real de la org B —
   * bloqueado sin importar current_user_id.
   *
   * `started_by` poblado (mismo hallazgo E6/0098 que el test anterior): la
   * fila de la org B representa una corrida humana real de esa org (su
   * propio dueño), no una corrida autónoma del worker.
   */
  it('worker_role con app.current_org_id de la org A no puede actualizar una fila agent_runs de la org B', async () => {
    const db = await createMigratedDb();
    try {
      const { orgId: orgA } = await seedOrgAndUser(db, 'wk23-proposal03-orga');
      const { orgId: orgB, userId: ownerB } = await seedOrgAndUser(db, 'wk23-proposal03-orgb');
      const actorA = await seedMember(db, orgA, 'wk23-proposal03-actora@example.test', 'writer');

      const { rows: runB } = await db.query<{ id: string }>(
        "insert into agent_runs (org_id, agent_name, started_by) values ($1, 'redactor', $2) returning id",
        [orgB, ownerB],
      );

      const updated = await db.transaction(async (tx) => {
        await tx.query('set local role worker_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgA]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [actorA]);
        // A propósito SIN filtro de org_id en el WHERE: la defensa real
        // debe venir de RLS, no de que la query "se acuerde" de filtrar.
        return tx.query("update agent_runs set status = 'succeeded' where id = $1", [runB[0].id]);
      });
      expect(updated.rowCount).toBe(0);
    } finally {
      await db.close();
    }
  });
});
