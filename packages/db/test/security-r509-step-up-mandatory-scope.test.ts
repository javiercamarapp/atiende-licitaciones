import { mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createPgliteClient } from '../src/driver.js';
import { applyMigrations, getMigrationsDir, listMigrationFiles } from '../src/migrate.js';
import { seedOrg, seedUser } from './helpers.js';

/**
 * R5-09 (docs/auditoria-2/api-ronda5-reverificacion.md, BAJA-MEDIA): la
 * reverificación adversarial de ronda 5 confirmó que el alcance opcional
 * de `step_up_sessions.org_id`/`purpose` (R5-05, migración 0061) nunca se
 * activaba en el flujo real de `apps/web` -- toda sesión de step-up en
 * producción quedaba "genérica" (org_id/purpose NULL), reutilizable sin
 * restricción. La migración 0062 invalida (borra) esas sesiones genéricas
 * preexistentes y hace `org_id`/`purpose` NOT NULL; la 0063 añade un CHECK
 * de enum cerrado sobre `purpose`. Este archivo prueba el comportamiento
 * de esas dos migraciones directamente contra la base (sin pasar por
 * `apps/api`, cuya cobertura de `requireStepUp`/`assertStepUp*` vive en
 * `apps/api/test/security-r505-stepup-scope.test.ts`).
 */
describe('R5-09: migraciones 0062/0063 invalidan sesiones genéricas y cierran el esquema de step_up_sessions', () => {
  it('una base con sesiones de step-up "genéricas" preexistentes (org_id/purpose NULL, comportamiento R5-05) las pierde al migrar a 0062+, y las columnas quedan NOT NULL', async () => {
    const fullDir = getMigrationsDir();
    const allFiles = listMigrationFiles(fullDir);
    const upTo0061Index = allFiles.indexOf('0061_r505_step_up_scope.sql');
    expect(upTo0061Index).toBeGreaterThan(-1);
    const filesUpTo0061 = allFiles.slice(0, upTo0061Index + 1);

    // Directorio temporal con SOLO las migraciones hasta 0061 (inclusive) --
    // el punto exacto en el que org_id/purpose ya existen pero son NULLABLE
    // (diseño R5-05).
    const partialDir = mkdtempSync(join(tmpdir(), 'atiende-db-partial-migrations-r509-'));
    try {
      for (const file of filesUpTo0061) {
        copyFileSync(join(fullDir, file), join(partialDir, file));
      }

      const db = await createPgliteClient();
      try {
        const partialResult = await applyMigrations(db, { migrationsDir: partialDir });
        expect(partialResult.applied.length).toBe(filesUpTo0061.length);

        const org = await seedOrg(db, 'r509-org');
        const userId = await seedUser(db, 'r509-user@example.com');

        // Sesión "genérica" (org_id/purpose NULL) -- exactamente el diseño
        // opcional de R5-05, posible en este punto porque las columnas
        // todavía son NULLABLE.
        const generic = await db.query<{ id: string }>(
          "insert into step_up_sessions (user_id, expires_at) values ($1, now() + interval '5 minutes') returning id",
          [userId]
        );
        // Sesión con scope explícito (comportamiento que R5-05 permitía,
        // aunque ningún cliente real lo usara) -- esta SÍ debe sobrevivir
        // la migración: nunca tuvo el problema que R5-09 cierra.
        const scoped = await db.query<{ id: string }>(
          "insert into step_up_sessions (user_id, expires_at, org_id, purpose) values ($1, now() + interval '5 minutes', $2, 'company.rate_approval') returning id",
          [userId, org.orgId]
        );

        const beforeCount = await db.query<{ n: number }>('select count(*)::int as n from step_up_sessions');
        expect(beforeCount.rows[0].n).toBe(2);

        // Ahora se aplican TODAS las migraciones reales del repo (incluida
        // 0062/0063) desde el directorio real.
        const fullResult = await applyMigrations(db, { migrationsDir: fullDir });
        expect(fullResult.applied.length).toBeGreaterThan(0);

        // La sesión GENÉRICA fue eliminada por 0062; la de scope explícito sobrevive intacta.
        const afterRows = await db.query<{ id: string }>('select id from step_up_sessions');
        expect(afterRows.rows.map((r) => r.id)).toEqual([scoped.rows[0].id]);
        expect(afterRows.rows.map((r) => r.id)).not.toContain(generic.rows[0].id);

        // org_id/purpose son NOT NULL desde ahora: un INSERT sin alguno de
        // los dos falla explícitamente, nunca crea una sesión "genérica".
        await expect(
          db.query("insert into step_up_sessions (user_id, expires_at) values ($1, now() + interval '5 minutes')", [userId])
        ).rejects.toThrow();
        await expect(
          db.query(
            "insert into step_up_sessions (user_id, expires_at, org_id) values ($1, now() + interval '5 minutes', $2)",
            [userId, org.orgId]
          )
        ).rejects.toThrow();
        await expect(
          db.query(
            "insert into step_up_sessions (user_id, expires_at, purpose) values ($1, now() + interval '5 minutes', 'company.rate_approval')",
            [userId]
          )
        ).rejects.toThrow();

        // `consumed_at` (nueva columna, R5-09 single-use) existe y es NULL por defecto.
        const columns = await db.query<{ column_name: string; is_nullable: string }>(
          "select column_name, is_nullable from information_schema.columns where table_name = 'step_up_sessions' and column_name = 'consumed_at'"
        );
        expect(columns.rows.length).toBe(1);
        expect(columns.rows[0].is_nullable).toBe('YES');
        const consumedAt = await db.query<{ consumed_at: string | null }>('select consumed_at from step_up_sessions where id = $1', [scoped.rows[0].id]);
        expect(consumedAt.rows[0].consumed_at).toBeNull();
      } finally {
        await db.close();
      }
    } finally {
      rmSync(partialDir, { recursive: true, force: true });
    }
  });

  it('purpose está restringido al enum cerrado (CHECK, migración 0063): un valor fuera de la lista es rechazado', async () => {
    const db = await createPgliteClient();
    try {
      await applyMigrations(db);
      const org = await seedOrg(db, 'r509-enum-org');
      const userId = await seedUser(db, 'r509-enum-user@example.com');

      for (const purpose of ['company.rate_approval', 'expediente.approval', 'tool_call.approval', 'admin.action']) {
        await expect(
          db.query(
            "insert into step_up_sessions (user_id, expires_at, org_id, purpose) values ($1, now() + interval '5 minutes', $2, $3)",
            [userId, org.orgId, purpose]
          )
        ).resolves.toBeDefined();
      }

      await expect(
        db.query(
          "insert into step_up_sessions (user_id, expires_at, org_id, purpose) values ($1, now() + interval '5 minutes', $2, 'algo-inventado')",
          [userId, org.orgId]
        )
      ).rejects.toThrow();
    } finally {
      await db.close();
    }
  });

  it('una base ya migrada hasta el final se puede volver a migrar sin error (idempotente) y consumed_at/purpose_check quedan una sola vez', async () => {
    const db = await createPgliteClient();
    try {
      const first = await applyMigrations(db);
      const second = await applyMigrations(db);
      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(first.applied);

      const constraints = await db.query<{ conname: string }>(
        "select conname from pg_constraint where conname = 'chk_step_up_sessions_purpose'"
      );
      expect(constraints.rows.length).toBe(1);
    } finally {
      await db.close();
    }
  });
});
