import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, asActor } from './helpers.js';

describe('idempotency_keys', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('es única por (org_id, key): una segunda inserción con la misma clave falla', async () => {
    const org = await seedOrg(db, 'org-idem');
    const ownerId = await seedMember(db, org.orgId, 'owner-idem@example.com', 'owner');

    await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query(
        "insert into idempotency_keys (org_id, key, request_hash, expires_at) values ($1, 'abc', 'hash1', now() + interval '1 day')",
        [org.orgId]
      )
    );

    await expect(
      asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
        tx.query(
          "insert into idempotency_keys (org_id, key, request_hash, expires_at) values ($1, 'abc', 'hash2', now() + interval '1 day')",
          [org.orgId]
        )
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  it('la misma key es independiente entre organizaciones distintas', async () => {
    const orgA = await seedOrg(db, 'org-idem-a');
    const orgB = await seedOrg(db, 'org-idem-b');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-idem-a@example.com', 'owner');
    const ownerB = await seedMember(db, orgB.orgId, 'owner-idem-b@example.com', 'owner');

    await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query(
        "insert into idempotency_keys (org_id, key, request_hash, expires_at) values ($1, 'same-key', 'h', now() + interval '1 day')",
        [orgA.orgId]
      )
    );

    await expect(
      asActor(db, { orgId: orgB.orgId, userId: ownerB }, (tx) =>
        tx.query(
          "insert into idempotency_keys (org_id, key, request_hash, expires_at) values ($1, 'same-key', 'h', now() + interval '1 day')",
          [orgB.orgId]
        )
      )
    ).resolves.toBeDefined();
  });
});

describe('audit_log (append-only)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('permite INSERT y SELECT a miembros de la org, pero ningún rol puede UPDATE ni DELETE', async () => {
    const org = await seedOrg(db, 'org-audit');
    const ownerId = await seedMember(db, org.orgId, 'owner-audit@example.com', 'owner');

    const inserted = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query(
        "insert into audit_log (org_id, actor_id, action, entity) values ($1, $2, 'create', 'tender') returning id",
        [org.orgId, ownerId]
      )
    );
    const id = (inserted.rows[0] as any).id;

    // No hay políticas de UPDATE/DELETE para audit_log (0008_rls_policies.sql):
    // con RLS habilitado y ninguna política para ese comando, Postgres filtra
    // todas las filas silenciosamente (0 filas afectadas), no lanza excepción.
    const upd = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query("update audit_log set action = 'tampered' where id = $1", [id])
    );
    expect(upd.rowCount).toBe(0);

    const del = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query('delete from audit_log where id = $1', [id])
    );
    expect(del.rowCount).toBe(0);

    const seen = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query('select action from audit_log where id = $1', [id])
    );
    expect((seen.rows[0] as any).action).toBe('create');
  });

  it('otra organización no ve las entradas de auditoría de la primera', async () => {
    const orgA = await seedOrg(db, 'org-audit-a');
    const orgB = await seedOrg(db, 'org-audit-b');
    const ownerA = await seedMember(db, orgA.orgId, 'owner-audit-a@example.com', 'owner');
    const ownerB = await seedMember(db, orgB.orgId, 'owner-audit-b@example.com', 'owner');

    const inserted = await asActor(db, { orgId: orgA.orgId, userId: ownerA }, (tx) =>
      tx.query(
        "insert into audit_log (org_id, actor_id, action, entity) values ($1, $2, 'create', 'tender') returning id",
        [orgA.orgId, ownerA]
      )
    );
    const id = (inserted.rows[0] as any).id;

    const seenFromB = await asActor(db, { orgId: orgB.orgId, userId: ownerB }, (tx) =>
      tx.query('select id from audit_log where id = $1', [id])
    );
    expect(seenFromB.rows.length).toBe(0);
  });
});
