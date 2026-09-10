import { describe, it, expect } from 'vitest';
import type { DbClient, DbExecutor } from '@atiende/db';
import { withTenantContext } from '@atiende/db';
import { createMigratedDb, seedOrgAndUser } from '../test/helpers.js';

/**
 * E6 (docs/BLOQUEOS.md, "E6-ciclo-agentes"): activa los tests que
 * acompañaban a PROPOSAL-06 (Ronda 6, agentes de negocio reales) — mismo
 * patrón que la activación WK-22 de PROPOSAL-01/02/03
 * (`PROPOSAL-01/02/03-*.test.ts`, `packages/db/test/
 * worker-role-and-job-proposals.test.ts`).
 * `packages/db/migrations/0098_e6_agent_business_tools_grants.sql` YA está
 * aplicada (`createMigratedDb()` la incluye siempre): los grants/políticas
 * ya no se aplican a mano con `applyProposal06` dentro de cada test.
 *
 * Los dos tests que verificaban el comportamiento "SIN la propuesta
 * aplicada" (fail-closed de `SchemaGrantPendingError`) ya no pueden
 * construir esa base con el runner real de migraciones (que siempre
 * incluye 0098) — simulan la ausencia revocando a mano el grant/política
 * exactos que 0098 añade, conservando la cobertura real del código de
 * `db-context.ts` como red de seguridad ante un drift de esquema futuro.
 */
async function revokeProposal06Grant(db: DbClient, table: string): Promise<void> {
  await db.exec(`
    drop policy if exists sel_${table}_worker_role on ${table};
    revoke select on ${table} from worker_role;
  `);
}

async function runAsWorkerRole<T>(db: DbClient, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query('set local role worker_role');
    return fn(tx);
  });
}

/**
 * WK6-03 (docs/auditoria-2/worker-agentes.md, BAJA): los 5 tests de este
 * archivo hacen cada uno `createMigratedDb()` (TODAS las migraciones reales
 * de packages/db) más varias consultas/transacciones reales contra PGlite.
 * Bajo la suite COMPLETA de `apps/worker` (21+ archivos de test corriendo
 * PGlite en paralelo) la auditoría midió contención real: 582ms aislado para
 * el test que falló, pero un timeout bajo carga completa con el `testTimeout`
 * por defecto de vitest (5000ms), no reproducible ni aislado ni en una
 * segunda corrida completa. No es un defecto funcional del código auditado:
 * es margen insuficiente frente a la contención de recursos del entorno.
 *
 * El timeout se sube a 20000ms para TODO ESTE archivo, no solo para el test
 * que perdió la carrera esa vez: los 5 comparten exactamente el mismo trabajo
 * pesado y el mismo riesgo, y cuál de ellos pierde la carrera bajo contención
 * es arbitrario — subirlo solo en uno dejaría a los otros 4 igual de frágiles.
 * 20000ms son >30x el tiempo medido aislado y 4x el default: margen suficiente
 * para la contención observada sin ocultar un timeout genuino si el código se
 * volviera realmente lento. El default de 5000ms se conserva para el resto de
 * la suite (no se toca `vitest.config.ts`), para no enmascarar regresiones de
 * rendimiento en otros archivos.
 */
describe('PROPOSAL-06: grants de solo-lectura de negocio + insert de agent_runs para worker_role', { timeout: 20_000 }, () => {
  it('worker_role puede leer tenders/company_profiles de CUALQUIER organización tras aplicar la propuesta', async () => {
    const db = await createMigratedDb();
    try {
      const { orgId } = await seedOrgAndUser(db, 'proposal06-read-tenders');
      await db.query(
        `insert into tenders (org_id, source, external_id, title) values ($1, 'comprasmx', 'ext-1', 'Convocatoria de prueba')`,
        [orgId],
      );
      await db.query(`insert into company_profiles (org_id, legal_name) values ($1, 'Empresa de prueba SA de CV')`, [orgId]);

      const tenders = await runAsWorkerRole(db, (tx) => tx.query('select id, title from tenders where org_id = $1', [orgId]));
      expect(tenders.rows).toHaveLength(1);

      const profiles = await runAsWorkerRole(db, (tx) =>
        tx.query('select legal_name from company_profiles where org_id = $1', [orgId]),
      );
      expect(profiles.rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  /**
   * Descubierto probando esto contra PGlite real, no una suposición de
   * diseño: `worker_role` YA hereda (`grant app_role to worker_role ...
   * inherit`, 0028) los privilegios de TABLA por defecto de `app_role`
   * (0001_bootstrap.sql `alter default privileges ... grant select...`),
   * así que un SELECT crudo sin política RLS que reconozca a `worker_role`
   * no lanza ningún error de permisos — RLS simplemente FILTRA las filas en
   * silencio, devolviendo una lista VACÍA. Devolver esa lista vacía como si
   * fuera un resultado real de negocio sería exactamente el tipo de
   * fabricación de éxito que este proyecto prohíbe (REQ-150). Por eso
   * `src/agents/db-context.ts` (`withWorkerBusinessReadContext`) NUNCA
   * confía en el resultado crudo del SELECT: verifica PRIMERO, contra el
   * catálogo real `pg_policies`, que la política de PROPOSAL-06 ya exista,
   * y solo entonces ejecuta la consulta de negocio — ver el segundo `it`
   * de este bloque.
   */
  it('SIN la política de 0098, un SELECT crudo de worker_role sobre tenders NO lanza error: devuelve 0 filas en silencio (RLS filtra, no bloquea la sentencia)', async () => {
    const db = await createMigratedDb();
    try {
      await revokeProposal06Grant(db, 'tenders');
      const { orgId } = await seedOrgAndUser(db, 'proposal06-no-grant-yet');
      await db.query(`insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'ext-2', 'Otra convocatoria')`, [
        orgId,
      ]);

      const result = await runAsWorkerRole(db, (tx) => tx.query('select id from tenders where org_id = $1', [orgId]));
      expect(result.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  });

  // WK6-03: este es el test que la auditoría vio expirar bajo carga completa
  // (582ms aislado). El margen ahora viene del `timeout` del `describe`.
  it('SIN la política de 0098, withWorkerBusinessReadContext SÍ falla explícito (SchemaGrantPendingError vía pg_policies, nunca una lista vacía fabricada)', async () => {
    const db = await createMigratedDb();
    try {
      await revokeProposal06Grant(db, 'tenders');
      const { orgId } = await seedOrgAndUser(db, 'proposal06-no-grant-yet-2');
      await db.query(`insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'ext-4', 'Convocatoria sin política')`, [
        orgId,
      ]);

      const { withWorkerBusinessReadContext, SchemaGrantPendingError } = await import('../src/agents/db-context.js');
      await expect(
        withWorkerBusinessReadContext(db, orgId, ['tenders'], (tx) => tx.query('select id from tenders where org_id = $1', [orgId])),
      ).rejects.toBeInstanceOf(SchemaGrantPendingError);
    } finally {
      await db.close();
    }
  });

  it('worker_role puede INSERTAR su propia fila en agent_runs (corrida disparada por evento de plataforma, sin agentRunId previo de apps/api)', async () => {
    const db = await createMigratedDb();
    try {
      const { orgId } = await seedOrgAndUser(db, 'proposal06-agent-runs-insert');

      const inserted = await db.transaction(async (tx) => {
        await tx.query('set local role worker_role');
        return tx.query<{ id: string }>(
          `insert into agent_runs (org_id, agent_name, status) values ($1, 'vigilante_cambios', 'running') returning id`,
          [orgId],
        );
      });
      expect(inserted.rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('las políticas ADICIONALES no reemplazan las existentes: un miembro humano real de la organización sigue pudiendo leer sus propios tenders', async () => {
    const db = await createMigratedDb();
    try {
      const { orgId, userId } = await seedOrgAndUser(db, 'proposal06-human-still-works');
      await db.query(`insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'ext-3', 'Convocatoria humana')`, [
        orgId,
      ]);

      const seen = await withTenantContext(db, { orgId, userId }, (tx) =>
        tx.query('select id from tenders where org_id = $1', [orgId]),
      );
      expect(seen.rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  });
});
