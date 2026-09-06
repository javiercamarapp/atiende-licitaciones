import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbClient } from './driver.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Directorio de migraciones SQL numeradas (packages/db/migrations). */
export function getMigrationsDir(): string {
  return join(__dirname, '..', 'migrations');
}

export function listMigrationFiles(dir: string = getMigrationsDir()): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Crea la tabla de control de migraciones si no existe (idempotente). */
export async function ensureMigrationsTable(db: DbClient): Promise<void> {
  await db.exec(`
    create table if not exists schema_migrations (
      filename text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
  `);
}

export interface ApplyMigrationsResult {
  applied: string[];
  skipped: string[];
}

/**
 * Aplica en orden las migraciones pendientes registradas en
 * `schema_migrations`. Es seguro llamarla varias veces: las ya aplicadas se
 * omiten (comparando el nombre de archivo) y, si el contenido de una
 * migración ya aplicada cambió, se lanza un error explícito en vez de
 * reaplicarla silenciosamente (protección contra migraciones editadas tras
 * desplegarse).
 */
export async function applyMigrations(
  db: DbClient,
  options: { migrationsDir?: string } = {}
): Promise<ApplyMigrationsResult> {
  const dir = options.migrationsDir ?? getMigrationsDir();
  await ensureMigrationsTable(db);

  const files = listMigrationFiles(dir);
  const { rows: appliedRows } = await db.query<{ filename: string; checksum: string }>(
    'select filename, checksum from schema_migrations'
  );
  const applied = new Map(appliedRows.map((r) => [r.filename, r.checksum]));

  const result: ApplyMigrationsResult = { applied: [], skipped: [] };

  for (const file of files) {
    const sql = readFileSync(join(dir, file), 'utf8');
    const hash = checksum(sql);
    const previousHash = applied.get(file);

    if (previousHash) {
      if (previousHash !== hash) {
        throw new Error(
          `La migración ${file} ya fue aplicada con un contenido distinto (checksum no coincide). ` +
            'No se reaplica automáticamente: crea una nueva migración en vez de editar una ya desplegada.'
        );
      }
      result.skipped.push(file);
      continue;
    }

    await db.exec(sql);
    await db.query('insert into schema_migrations (filename, checksum) values ($1, $2)', [file, hash]);
    result.applied.push(file);
  }

  return result;
}
