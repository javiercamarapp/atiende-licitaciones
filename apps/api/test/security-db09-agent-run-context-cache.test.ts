import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from './helpers.js';
import { PgRunStore, PgToolCallStore } from '../src/lib/agent-stores.pg.js';

/**
 * DB-09 residual (docs/auditoria-1/db-api-reverificacion.md, BAJA) —
 * `getRun`/`updateRun`/`listToolCalls` no reciben `orgId` en su firma
 * (contrato externo de `RunStore`/`ToolCallStore`, packages/agents) y
 * antes SIEMPRE recurrían a `app.agent_run_context` (`SECURITY DEFINER`)
 * para descubrirlo, incluso para una corrida/tool_call que la MISMA
 * instancia de store acababa de crear con datos reales conocidos.
 * `agent-stores.pg.ts` ahora cachea ese contexto (poblado con datos reales
 * de `createRun`/`recordToolCall`, nunca de la función) y solo cae al
 * oracle si no está en caché.
 *
 * Esta prueba lo demuestra QUITANDO el permiso de ejecución de la función
 * (`REVOKE EXECUTE`) y comprobando que: (a) la MISMA instancia que creó la
 * corrida sigue funcionando sin problema (nunca necesitó la función), y
 * (b) una instancia NUEVA (sin caché, equivalente a un reinicio de
 * proceso) sí falla -- prueba directa de que el camino común ya no
 * depende del oracle, y que el riesgo residual documentado queda acotado
 * exactamente al caso "instancia nueva" que la reverificación ya identificó.
 */
describe('DB-09 residual — la caché de PgRunStore/PgToolCallStore evita el oracle en el camino común', () => {
  let app: FastifyInstance;
  let db: DbClient;

  beforeEach(async () => {
    ({ app, db } = await createTestApp());
  });

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  async function seedOrgAndUser(slug: string): Promise<{ orgId: string; userId: string }> {
    const { rows } = await db.query<{ id: string }>('insert into organizations (name, slug) values ($1, $1) returning id', [slug]);
    const orgId = rows[0].id;
    const { rows: userRows } = await db.query<{ id: string }>(
      "insert into users (id, email, password_hash) values (gen_random_uuid(), $1, 'x') returning id",
      [`${slug}@example.com`]
    );
    const userId = userRows[0].id;
    await db.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'writer')", [orgId, userId]);
    return { orgId, userId };
  }

  it('PgRunStore: updateRun/getRun de un run creado por la MISMA instancia funciona sin el oracle; una instancia NUEVA sí lo necesita y falla si está revocado', async () => {
    const { orgId, userId } = await seedOrgAndUser('db09-org-1');
    const runStore = new PgRunStore(db);
    const created = await runStore.createRun({ organizationId: orgId, agentName: 'redactor', actorId: userId, actorRole: 'writer' as any, totalSteps: 2 });

    await db.query('revoke execute on function app.agent_run_context(uuid) from public, app_role');
    try {
      // Camino común: la MISMA instancia, que ya cacheó el contexto real al crear -> funciona sin tocar la función revocada.
      const updated = await runStore.updateRun(created.id, { completedSteps: 1 });
      expect(updated.completedSteps).toBe(1);
      const reread = await runStore.getRun(created.id);
      expect(reread?.completedSteps).toBe(1);

      // Instancia NUEVA (sin caché, equivalente a un reinicio de proceso): sí depende del oracle -> falla con la función revocada.
      const freshStore = new PgRunStore(db);
      await expect(freshStore.getRun(created.id)).rejects.toThrow();
    } finally {
      await db.query('grant execute on function app.agent_run_context(uuid) to public');
    }

    // Con el permiso restaurado, la instancia nueva sí puede resolverlo (comportamiento normal preservado).
    const restoredStore = new PgRunStore(db);
    const rereadAfterRestore = await restoredStore.getRun(created.id);
    expect(rereadAfterRestore?.id).toBe(created.id);
  });

  it('PgToolCallStore: listToolCalls de un run grabado por la MISMA instancia funciona sin el oracle; una instancia NUEVA sí lo necesita', async () => {
    const { orgId, userId } = await seedOrgAndUser('db09-org-2');
    const runStore = new PgRunStore(db);
    const run = await runStore.createRun({ organizationId: orgId, agentName: 'redactor', actorId: userId, actorRole: 'writer' as any, totalSteps: 1 });

    const toolCallStore = new PgToolCallStore(db);
    await toolCallStore.recordToolCall({
      id: randomUUID(),
      runId: run.id,
      stepIndex: 0,
      toolName: 'search_tenders',
      organizationId: orgId,
      actorId: userId,
      actorRole: 'writer' as any,
      status: 'ok',
      startedAt: new Date().toISOString(),
      inputHash: 'x',
      attempts: 1,
      estimatedTokens: 10,
      estimatedCostUsd: 0,
      correlationId: null,
    });

    await db.query('revoke execute on function app.agent_run_context(uuid) from public, app_role');
    try {
      const listed = await toolCallStore.listToolCalls(run.id);
      expect(listed.length).toBe(1);
      expect(listed[0].toolName).toBe('search_tenders');

      const freshToolCallStore = new PgToolCallStore(db);
      await expect(freshToolCallStore.listToolCalls(run.id)).rejects.toThrow();
    } finally {
      await db.query('grant execute on function app.agent_run_context(uuid) to public');
    }
  });
});
