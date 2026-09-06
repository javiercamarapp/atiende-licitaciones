import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createPgliteClient } from '../src/driver.js';
import { applyMigrations, getMigrationsDir, listMigrationFiles } from '../src/migrate.js';

/**
 * Reverificación de apps/worker sobre PROPOSAL-02: `create unique index
 * ux_jobs_kind_jobkey_active` (0027_jobs_dedupe_and_cancelled.sql) fallaría
 * si el entorno que aplica las migraciones ya tiene jobs activos duplicados
 * por (kind, jobKey) -- p. ej. insertados antes de que `JobQueue.enqueue()`
 * tuviera el advisory lock. Este test reproduce EXACTAMENTE ese escenario:
 * aplica las migraciones solo hasta 0026 (antes de que exista la función de
 * limpieza ni el índice único), inserta duplicados activos a mano (posible
 * en ese punto porque el índice todavía no existe), y luego aplica el
 * RESTO de migraciones reales del repo (0026b en adelante) para confirmar
 * que 0026b los resuelve ANTES de que 0027 intente crear el índice, sin que
 * la migración completa falle.
 */
describe('0026b: resuelve duplicados activos preexistentes antes del índice único de 0027', () => {
  it('una base con jobs activos duplicados por (kind, jobKey) migra limpiamente hasta el final', async () => {
    const fullDir = getMigrationsDir();
    const allFiles = listMigrationFiles(fullDir);
    const upTo0026Index = allFiles.indexOf('0026_widen_source_run_status.sql');
    expect(upTo0026Index).toBeGreaterThan(-1);
    const filesUpTo0026 = allFiles.slice(0, upTo0026Index + 1);

    // Directorio temporal con SOLO las migraciones hasta 0026 (inclusive).
    const partialDir = mkdtempSync(join(tmpdir(), 'atiende-db-partial-migrations-'));
    try {
      for (const file of filesUpTo0026) {
        copyFileSync(join(fullDir, file), join(partialDir, file));
      }

      const db = await createPgliteClient();
      try {
        const partialResult = await applyMigrations(db, { migrationsDir: partialDir });
        expect(partialResult.applied.length).toBe(filesUpTo0026.length);

        // En este punto el índice único de 0027 TODAVÍA NO EXISTE: se
        // pueden insertar duplicados activos a mano, tal como ocurriría en
        // un entorno real con datos previos a esta migración.
        await db.query(
          `insert into jobs (kind, payload, status, created_at) values
             ('discover_tenders', '{"jobKey": "dup-key"}'::jsonb, 'queued', now() - interval '2 hours'),
             ('discover_tenders', '{"jobKey": "dup-key"}'::jsonb, 'running', now() - interval '1 hour'),
             ('discover_tenders', '{"jobKey": "dup-key"}'::jsonb, 'queued', now())`
        );
        const before = await db.query<{ status: string }>(
          "select status from jobs where payload ->> 'jobKey' = 'dup-key'"
        );
        expect(before.rows.length).toBe(3);

        // Ahora se aplican TODAS las migraciones reales del repo (incluida
        // 0026b, 0027, 0028...) desde el directorio real -- exactamente lo
        // que correría en un despliegue real.
        const fullResult = await applyMigrations(db, { migrationsDir: fullDir });
        expect(fullResult.applied.length).toBeGreaterThan(0);

        // 0026b debe haber resuelto los duplicados ANTES de que 0027 creara
        // el índice único: solo 1 job sigue activo (el más reciente, per
        // "se conservó el más reciente" documentado en la migración); los
        // otros 2 quedaron 'dead' con el motivo explicado en last_error.
        const after = await db.query<{ status: string; last_error: string | null }>(
          "select status, last_error from jobs where payload ->> 'jobKey' = 'dup-key' order by created_at asc"
        );
        expect(after.rows.length).toBe(3);
        const activeCount = after.rows.filter((r) => r.status === 'queued' || r.status === 'running').length;
        expect(activeCount).toBe(1);
        const resolvedRows = after.rows.filter((r) => r.status === 'dead');
        expect(resolvedRows.length).toBe(2);
        for (const row of resolvedRows) {
          expect(row.last_error).toMatch(/resuelto por app.resolve_duplicate_active_jobs/);
        }

        // El índice único de 0027 SÍ terminó de crearse (la migración
        // completa no abortó a mitad de camino): un nuevo INSERT duplicado
        // activo ahora sí es rechazado.
        await expect(
          db.query("insert into jobs (kind, payload, status) values ('discover_tenders', '{\"jobKey\": \"dup-key\"}'::jsonb, 'queued')")
        ).rejects.toThrow();
      } finally {
        await db.close();
      }
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  });

  it('app.resolve_duplicate_active_jobs() es idempotente: una segunda ejecución no toca nada más', async () => {
    const db = await createPgliteClient();
    try {
      await applyMigrations(db);
      await db.query(
        `insert into jobs (kind, payload, status, created_at) values
           ('discover_tenders', '{"jobKey": "idempotent-key"}'::jsonb, 'queued', now())`
      );
      const first = await db.query<{ resolved: number }>('select app.resolve_duplicate_active_jobs() as resolved');
      expect(first.rows[0].resolved).toBe(0);
      const second = await db.query<{ resolved: number }>('select app.resolve_duplicate_active_jobs() as resolved');
      expect(second.rows[0].resolved).toBe(0);
    } finally {
      await db.close();
    }
  });
});
