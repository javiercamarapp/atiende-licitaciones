import { describe, it, expect } from 'vitest';
import { createPgliteClient } from '../src/driver.js';
import { applyMigrations, listMigrationFiles, ensureMigrationsTable } from '../src/migrate.js';

describe('migraciones', () => {
  it('aplican todas sin error y quedan registradas en schema_migrations', async () => {
    const db = await createPgliteClient();
    try {
      const files = listMigrationFiles();
      expect(files.length).toBeGreaterThan(0);

      const first = await applyMigrations(db);
      expect(first.applied).toEqual(files);
      expect(first.skipped).toEqual([]);

      const { rows } = await db.query('select filename from schema_migrations order by filename');
      expect(rows.map((r: any) => r.filename)).toEqual(files);
    } finally {
      await db.close();
    }
  });

  it('se pueden aplicar dos veces sin error (idempotente): la segunda vez no repite nada', async () => {
    const db = await createPgliteClient();
    try {
      const first = await applyMigrations(db);
      const second = await applyMigrations(db);

      expect(second.applied).toEqual([]);
      expect(second.skipped).toEqual(first.applied);

      const { rows } = await db.query('select count(*)::int as n from schema_migrations');
      expect((rows[0] as any).n).toBe(listMigrationFiles().length);
    } finally {
      await db.close();
    }
  });

  it('ensureMigrationsTable es idempotente', async () => {
    const db = await createPgliteClient();
    try {
      await ensureMigrationsTable(db);
      await ensureMigrationsTable(db);
      const { rows } = await db.query(
        "select table_name from information_schema.tables where table_name = 'schema_migrations'"
      );
      expect(rows.length).toBe(1);
    } finally {
      await db.close();
    }
  });

  it('crea todas las tablas de dominio esperadas', async () => {
    const db = await createPgliteClient();
    try {
      await applyMigrations(db);
      const { rows } = await db.query<{ table_name: string }>(
        "select table_name from information_schema.tables where table_schema = 'public' order by table_name"
      );
      const tables = rows.map((r) => r.table_name);
      const expected = [
        'agent_runs',
        'api_keys',
        'audit_log',
        'compliance_items',
        'go_no_go_decisions',
        'idempotency_keys',
        'invitations',
        'jobs',
        'memberships',
        'organizations',
        'platform_admins',
        'post_award_followups',
        'proposal_section_fingerprints',
        'proposal_sections',
        'proposal_similarity_flags',
        'proposals',
        'rate_limit_buckets',
        'rate_limits',
        'requirement_items',
        'reviews',
        'schema_migrations',
        'submissions',
        'tender_documents',
        'tender_matches',
        'tenders',
        'tool_calls',
        'users',
      ];
      for (const t of expected) {
        expect(tables).toContain(t);
      }
    } finally {
      await db.close();
    }
  });
});
