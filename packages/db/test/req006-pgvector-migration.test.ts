import { describe, it, expect } from 'vitest';
import { createPgliteClient } from '../src/driver.js';
import { applyMigrations } from '../src/migrate.js';

/**
 * REQ-006: verifica el comportamiento de la migración 0099 en el entorno de
 * pruebas REAL de este repo (PGlite) -- que, a la fecha de esta migración,
 * NO empaqueta la extensión `vector` (confirmado inspeccionando
 * node_modules/@electric-sql/pglite: no hay export ni tarball `vector` en la
 * versión instalada). Este test documenta y fija ese comportamiento: la
 * migración debe aplicar limpio y `app.pgvector_available()` debe reportar
 * `false`, activando el camino de fallback determinista de
 * `apps/api/src/modules/matching/semantic.ts` (no un mock de esa lógica:
 * PGlite es el motor Postgres real usado en toda la suite del repo, ver
 * packages/db/README.md).
 */
describe('REQ-006: migración 0099 (pgvector) en PGlite', () => {
  it('aplica sin error y deja constancia explícita de que pgvector NO está disponible', async () => {
    const db = await createPgliteClient();
    try {
      await applyMigrations(db);

      const { rows } = await db.query<{ available: boolean }>('select app.pgvector_available() as available');
      expect(rows[0].available).toBe(false);

      const { rows: extRows } = await db.query('select 1 from pg_extension where extname = $1', ['vector']);
      expect(extRows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('sin la extensión, NO crea la columna embedding_vec ni el RPC match_procedures (nunca finge una capacidad que no existe)', async () => {
    const db = await createPgliteClient();
    try {
      await applyMigrations(db);

      const { rows: colRows } = await db.query(
        "select column_name from information_schema.columns where table_name = 'tender_embeddings' and column_name = 'embedding_vec'"
      );
      expect(colRows).toEqual([]);

      const { rows: fnRows } = await db.query(
        "select 1 from pg_proc where proname = 'match_procedures'"
      );
      expect(fnRows).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('crea tender_embeddings y company_profile_embeddings con embedding_fallback y RLS activa', async () => {
    const db = await createPgliteClient();
    try {
      await applyMigrations(db);

      const { rows: tables } = await db.query<{ table_name: string; row_security: string }>(
        `select c.relname as table_name, case when c.relrowsecurity then 'YES' else 'NO' end as row_security
         from pg_class c
         where c.relname in ('tender_embeddings', 'company_profile_embeddings') and c.relkind = 'r'`
      );
      const byName = new Map(tables.map((t) => [t.table_name, t.row_security]));
      expect(byName.get('tender_embeddings')).toBe('YES');
      expect(byName.get('company_profile_embeddings')).toBe('YES');

      const { rows: cols } = await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'tender_embeddings' order by column_name"
      );
      const colNames = cols.map((c) => c.column_name);
      expect(colNames).toEqual(
        expect.arrayContaining(['org_id', 'tender_id', 'source_text_hash', 'model', 'dims', 'embedding_fallback'])
      );
    } finally {
      await db.close();
    }
  });
});
