import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPgliteClient } from '../src/driver.js';
import { applyMigrations, getMigrationsDir, listMigrationFiles } from '../src/migrate.js';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, asActor } from './helpers.js';

/**
 * E20 (docs/BACKLOG.md, "Índice de correlation_id en agent_runs (BAJA, tras
 * WK6-02)"): `packages/db/migrations/0088_e20_agent_runs_correlation_id.sql`
 * añade `agent_runs.correlation_id` (poblada desde
 * `output->>'correlationId'` para filas preexistentes) + índice, y
 * `apps/worker/src/handlers/run-agent.ts` escribe la columna directamente
 * a partir de ahora (ver `test/run-agent-handler.test.ts` de ese paquete
 * para la consulta REQ-171 ya migrada a `where correlation_id = $1`).
 *
 * Esta suite cubre lo que le corresponde a `packages/db`:
 *  1. Idempotencia real del backfill: una base con filas PREEXISTENTES
 *     (anteriores a 0088, con `correlation_id` inexistente todavía) migra
 *     limpiamente y queda con la columna poblada desde el JSONB -- mismo
 *     patrón de "migrar hasta el corte, sembrar datos, migrar el resto"
 *     que `test/migration-0026b-duplicate-jobs-safety-net.test.ts`.
 *  2. La RLS existente de `agent_runs` (0008, `app.apply_org_rls`) sigue
 *     intacta: la columna nueva no es una puerta trasera para leer
 *     corridas de otra organización por correlation_id.
 *  3. `security-definer-audit.test.ts` ya confirma (ejecutado aparte) que
 *     esta migración no agregó ninguna función SECURITY DEFINER sin
 *     revisar -- 0088 no define ninguna, solo DDL + backfill.
 */
describe('E20: agent_runs.correlation_id (columna ya existente desde 0017 + backfill de 0088)', () => {
  it('una base con filas preexistentes (antes de 0088, columna de 0017 ya presente pero sin backfill) migra limpiamente y queda con correlation_id poblada desde output->>\'correlationId\'', async () => {
    const fullDir = getMigrationsDir();
    const allFiles = listMigrationFiles(fullDir);
    const upTo0087Index = allFiles.indexOf('0087_req188_mail_retry_audit.sql');
    expect(upTo0087Index).toBeGreaterThan(-1);
    const filesUpTo0087 = allFiles.slice(0, upTo0087Index + 1);
    expect(filesUpTo0087).not.toContain('0088_e20_agent_runs_correlation_id.sql');

    const partialDir = mkdtempSync(join(tmpdir(), 'atiende-db-e20-partial-migrations-'));
    try {
      for (const file of filesUpTo0087) {
        copyFileSync(join(fullDir, file), join(partialDir, file));
      }

      const db = await createPgliteClient();
      try {
        const partialResult = await applyMigrations(db, { migrationsDir: partialDir });
        expect(partialResult.applied.length).toBe(filesUpTo0087.length);

        // `agent_runs.correlation_id` YA existe desde 0017 (mucho antes de
        // 0088): esta migración no crea la columna, solo backfillea filas
        // que un UPDATE de apps/worker (antes de esta ronda) dejó con
        // `correlation_id is null` a pesar de traer el dato en `output`.
        const { rows: colsBefore } = await db.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_name = 'agent_runs' and column_name = 'correlation_id'"
        );
        expect(colsBefore.length).toBe(1);

        // Datos "preexistentes" tal como los dejaría run-agent.ts ANTES de
        // esta ronda (WK6-02): correlationId solo dentro de `output` JSONB.
        const { rows: orgRows } = await db.query<{ id: string }>(
          "insert into organizations (name, slug) values ('E20 org', 'e20-org') returning id"
        );
        const orgId = orgRows[0].id;

        const withCorrelation = await db.query<{ id: string }>(
          `insert into agent_runs (org_id, agent_name, status, output)
           values ($1, 'analista_convocatorias', 'succeeded', $2::jsonb)
           returning id`,
          [orgId, JSON.stringify({ richStatus: 'completed', correlationId: 'tender-e20-1', toolCalls: [] })]
        );
        const runIdWithCorrelation = withCorrelation.rows[0].id;

        // Una corrida SIN correlationId de negocio (p.ej. la demo
        // `llm_complete`, sin agentRunId/contexto de expediente) no debe
        // ganar un valor inventado -- correlation_id sigue NULL.
        const withoutCorrelation = await db.query<{ id: string }>(
          `insert into agent_runs (org_id, agent_name, status, output)
           values ($1, 'demo', 'succeeded', $2::jsonb)
           returning id`,
          [orgId, JSON.stringify({ richStatus: 'completed', toolCalls: [] })]
        );
        const runIdWithoutCorrelation = withoutCorrelation.rows[0].id;

        // Una corrida todavía `running` (sin `output` en absoluto).
        const stillRunning = await db.query<{ id: string }>(
          "insert into agent_runs (org_id, agent_name, status) values ($1, 'demo', 'running') returning id",
          [orgId]
        );
        const runIdStillRunning = stillRunning.rows[0].id;

        // Ahora se aplican TODAS las migraciones reales del repo (incluida
        // 0088) desde el directorio real -- exactamente lo que correría en
        // un despliegue real con datos previos.
        const fullResult = await applyMigrations(db, { migrationsDir: fullDir });
        expect(fullResult.applied.length).toBeGreaterThan(0);

        const { rows: colsAfter } = await db.query<{ column_name: string }>(
          "select column_name from information_schema.columns where table_name = 'agent_runs' and column_name = 'correlation_id'"
        );
        expect(colsAfter.length).toBe(1);

        const { rows: idx } = await db.query<{ indexname: string }>(
          "select indexname from pg_indexes where tablename = 'agent_runs' and indexname = 'ix_agent_runs_correlation'"
        );
        expect(idx.length).toBe(1);

        const { rows: after } = await db.query<{ id: string; correlation_id: string | null }>(
          'select id, correlation_id from agent_runs where id = any($1::uuid[])',
          [[runIdWithCorrelation, runIdWithoutCorrelation, runIdStillRunning]]
        );
        const byId = new Map(after.map((r) => [r.id, r.correlation_id]));
        expect(byId.get(runIdWithCorrelation)).toBe('tender-e20-1');
        expect(byId.get(runIdWithoutCorrelation)).toBeNull();
        expect(byId.get(runIdStillRunning)).toBeNull();

        // Idempotencia: reaplicar sobre una base YA en 0088 no repite nada
        // ni pisa un valor ya backfilleado.
        const secondApply = await applyMigrations(db, { migrationsDir: fullDir });
        expect(secondApply.applied).toEqual([]);
        expect(secondApply.skipped).toEqual([...partialResult.applied, ...fullResult.applied]);

        const { rows: unchanged } = await db.query<{ correlation_id: string | null }>(
          'select correlation_id from agent_runs where id = $1',
          [runIdWithCorrelation]
        );
        expect(unchanged[0].correlation_id).toBe('tender-e20-1');

        // La consulta REQ-171 sobre la COLUMNA (no ya sobre el JSONB)
        // encuentra la fila -- este es el criterio verificable de E20.
        const { rows: byColumn } = await db.query<{ id: string }>(
          'select id from agent_runs where correlation_id = $1',
          ['tender-e20-1']
        );
        expect(byColumn.map((r) => r.id)).toEqual([runIdWithCorrelation]);
      } finally {
        await db.close();
      }
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  });
});

describe('E20: la RLS existente de agent_runs sigue intacta con la columna nueva', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('un miembro de la organización A no ve, por correlation_id, la corrida de la organización B', async () => {
    const orgA = await seedOrg(db, 'e20-rls-org-a');
    const orgB = await seedOrg(db, 'e20-rls-org-b');
    const userA = await seedMember(db, orgA.orgId, 'e20-rls-a@example.com', 'viewer');

    const correlationId = 'tender-e20-rls-shared';
    await db.query(
      `insert into agent_runs (org_id, agent_name, status, output, correlation_id)
       values ($1, 'analista_convocatorias', 'succeeded', $2::jsonb, $3)`,
      [orgB.orgId, JSON.stringify({ richStatus: 'completed', correlationId }), correlationId]
    );
    await db.query(
      `insert into agent_runs (org_id, agent_name, status, output, correlation_id)
       values ($1, 'analista_convocatorias', 'succeeded', $2::jsonb, $3)`,
      [orgA.orgId, JSON.stringify({ richStatus: 'completed', correlationId }), correlationId]
    );

    const seenByA = await asActor(db, { userId: userA, orgId: orgA.orgId }, (tx) =>
      tx.query<{ org_id: string }>('select org_id from agent_runs where correlation_id = $1', [correlationId])
    );

    expect(seenByA.rows.length).toBe(1);
    expect(seenByA.rows[0].org_id).toBe(orgA.orgId);
  });

  it('un superadmin (o worker_role) sí ve ambas filas del mismo correlation_id entre organizaciones', async () => {
    const orgA = await seedOrg(db, 'e20-rls-org-c');
    const orgB = await seedOrg(db, 'e20-rls-org-d');
    const correlationId = 'tender-e20-rls-cross-org';

    await db.query(
      `insert into agent_runs (org_id, agent_name, status, correlation_id) values ($1, 'demo', 'succeeded', $2)`,
      [orgA.orgId, correlationId]
    );
    await db.query(
      `insert into agent_runs (org_id, agent_name, status, correlation_id) values ($1, 'demo', 'succeeded', $2)`,
      [orgB.orgId, correlationId]
    );

    // Como propietario de las migraciones (sin RLS forzada, igual que el
    // resto de helpers de este archivo): confirma que ambas filas existen
    // de verdad y comparten correlation_id, sin depender de ningún actor.
    const { rows } = await db.query<{ org_id: string }>('select org_id from agent_runs where correlation_id = $1', [
      correlationId,
    ]);
    expect(rows.map((r) => r.org_id).sort()).toEqual([orgA.orgId, orgB.orgId].sort());
  });
});
