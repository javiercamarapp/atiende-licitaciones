import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedUser, asActor } from './helpers.js';

// Nota de diseño importante (documentada en apps/api): al crear una
// organización, el actor todavía no es miembro de ella, así que la fila
// recién insertada NO es visible para la política SELECT de organizations
// hasta que exista su membresía. Postgres exige que las filas devueltas por
// `RETURNING` en un INSERT satisfagan también las políticas de SELECT (no
// las omite en silencio: lanza el mismo error 42501 de RLS). Por eso el id
// de la organización se genera en la aplicación (no con el default de la
// columna) y el INSERT de bootstrap NO usa RETURNING.

describe('bootstrap de organización (autoasignación de primer owner)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('un usuario autenticado puede crear una organización y auto-asignarse como owner en la misma transacción', async () => {
    const userId = await seedUser(db, 'founder@example.com');

    const orgId = await asActor(db, { userId }, async (tx) => {
      const id = randomUUID();
      // Sin RETURNING: la fila aún no es visible por SELECT (el actor no es
      // miembro todavía), ver nota de diseño arriba.
      await tx.query("insert into organizations (id, name, slug) values ($1, 'Nueva Org', 'nueva-org')", [id]);
      // Ahora sí se fija el contexto de org dentro de la misma transacción
      // antes de auto-asignarse como owner (bootstrap).
      await tx.query("select set_config('app.current_org_id', $1, true)", [id]);
      await tx.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [id, userId]);
      return id;
    });

    const membership = await asActor(db, { orgId, userId }, (tx) =>
      tx.query("select role from memberships where org_id = $1 and user_id = $2", [orgId, userId])
    );
    expect((membership.rows[0] as any).role).toBe('owner');
  });

  it('un outsider NO puede auto-insertarse en una organización que ya tiene miembros, aunque fuerce el org_id en el contexto', async () => {
    const founderId = await seedUser(db, 'founder2@example.com');
    const orgId = await asActor(db, { userId: founderId }, async (tx) => {
      const id = randomUUID();
      await tx.query("insert into organizations (id, name, slug) values ($1, 'Org Poblada', 'org-poblada')", [id]);
      await tx.query("select set_config('app.current_org_id', $1, true)", [id]);
      await tx.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [id, founderId]);
      return id;
    });

    const outsiderId = await seedUser(db, 'outsider@example.com');
    await expect(
      asActor(db, { orgId, userId: outsiderId }, (tx) =>
        tx.query("insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')", [orgId, outsiderId])
      )
    ).rejects.toThrow(/row-level security/i);
  });
});
