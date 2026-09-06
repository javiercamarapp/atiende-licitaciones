import { createPgliteClient, applyMigrations, type DbClient, type OrgRole } from '@atiende/db';
import { createLogger } from '../src/logger.js';

/** Crea una base PGlite en memoria y aplica todas las migraciones reales (mismo patrón que packages/db/test/helpers.ts). */
export async function createMigratedDb(): Promise<DbClient> {
  const db = await createPgliteClient();
  await applyMigrations(db);
  return db;
}

/** Logger silencioso para pruebas (evita ruido en stdout de vitest). */
export function silentLogger() {
  return createLogger({ level: 'silent' });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Crea una organización y un usuario mínimos (como propietario de las migraciones, sin RLS), para pruebas que necesitan FKs válidas. */
export async function seedOrgAndUser(db: DbClient, slug: string): Promise<{ orgId: string; userId: string }> {
  const { rows: orgRows } = await db.query<{ id: string }>(
    'insert into organizations (name, slug) values ($1, $1) returning id',
    [slug],
  );
  const orgId = orgRows[0].id;
  const { rows: userRows } = await db.query<{ id: string }>(
    "insert into users (email, password_hash) values ($1, 'test-hash') returning id",
    [`${slug}@example.test`],
  );
  const userId = userRows[0].id;
  await db.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, 'owner']);
  return { orgId, userId };
}

/**
 * Crea un usuario adicional y lo hace miembro de una organización EXISTENTE
 * con el rol dado (mismo patrón que `packages/db/test/helpers.ts`
 * `seedMember`, reimplementado aquí en vez de importado — las apps no
 * dependen de `packages/db/test/*`, solo de sus exports públicos).
 */
export async function seedMember(db: DbClient, orgId: string, email: string, role: OrgRole): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "insert into users (email, password_hash) values ($1, 'test-hash') returning id",
    [email],
  );
  const userId = rows[0].id;
  await db.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [orgId, userId, role]);
  return userId;
}
