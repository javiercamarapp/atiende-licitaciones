import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DbClient } from '@atiende/db';

const here = dirname(fileURLToPath(import.meta.url));
const proposalSqlPath = join(here, '..', 'db-proposals', 'PROPOSAL-06-agent-business-tools-grants.sql');

/**
 * Aplica PROPOSAL-06 (apps/worker/db-proposals/) directamente sobre una base
 * YA migrada con las migraciones REALES de packages/db, sin tocar
 * packages/db/migrations/ — mismo patrón que
 * PROPOSAL-01/02/03-*.test.ts. Esto prueba que el código de
 * `src/agents/*` funciona correctamente una vez que esta propuesta se
 * incorpore a packages/db; NO implica que la propuesta ya esté aplicada en
 * ningún entorno real (ver comentario "PENDIENTE esquema" en el propio
 * archivo .sql).
 */
export async function applyProposal06(db: DbClient): Promise<void> {
  const sql = readFileSync(proposalSqlPath, 'utf8');
  // `db.exec()` (no `db.query()`): el archivo trae varias sentencias SQL —
  // mismo mecanismo que usa el propio migrador de packages/db
  // (`applyMigrations`, `packages/db/src/migrate.ts`) para aplicar un
  // archivo de migración completo de una sola vez.
  await db.exec(sql);
}
