import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedOrg, seedMember, seedUser, asActor } from './helpers.js';

describe('0017_ronda2_extensions: refresh tokens, aceptar invitación, approved_rates propuesta', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('refresh_tokens: crear, encontrar y revocar solo vía funciones SECURITY DEFINER (RLS sin políticas directas)', async () => {
    const userId = await seedUser(db, 'refresh-user@example.com');
    const tokenId = randomUUID();
    const tokenHash = createHash('sha256').update('token-1').digest('hex');

    // DB-08 (fix en 0040): `app.create_refresh_token` ahora exige que
    // `app.current_user_id()` ya esté fijado y coincida con el `p_user_id`
    // recibido -- se fija aquí vía `asActor` (mismo mecanismo que usa
    // apps/api/src/modules/auth/routes.ts en `issueTokenPair`), en vez de
    // invocarla en una sesión sin contexto (eso es exactamente lo que
    // permitía acuñar tokens para cualquier `user_id` antes del fix).
    await asActor(db, { userId }, (tx) =>
      tx.query('select app.create_refresh_token($1, $2, $3, now() + interval \'30 days\')', [tokenId, userId, tokenHash])
    );

    const found = await db.query<{ id: string; revoked_at: string | null }>(
      'select id, revoked_at from app.find_refresh_token($1)',
      [tokenHash]
    );
    expect(found.rows[0]?.id).toBe(tokenId);
    expect(found.rows[0]?.revoked_at).toBeNull();

    // Sin contexto de app_role, la tabla es directamente inaccesible (RLS sin políticas).
    const direct = await asActor(db, {}, (tx) => tx.query('select id from refresh_tokens where id = $1', [tokenId]));
    expect(direct.rows.length).toBe(0);

    await db.query('select app.revoke_refresh_token($1)', [tokenHash]);
    const afterRevoke = await db.query<{ revoked_at: string | null }>(
      'select revoked_at from app.find_refresh_token($1)',
      [tokenHash]
    );
    expect(afterRevoke.rows[0]?.revoked_at).not.toBeNull();
  });

  it('app.revoke_all_refresh_tokens revoca todos los tokens activos de un usuario (logout global)', async () => {
    const userId = await seedUser(db, 'refresh-all@example.com');
    const hashes = ['a', 'b', 'c'].map((s) => createHash('sha256').update(s).digest('hex'));
    for (const h of hashes) {
      await asActor(db, { userId }, (tx) =>
        tx.query('select app.create_refresh_token($1, $2, $3, now() + interval \'30 days\')', [randomUUID(), userId, h])
      );
    }
    // DB-08 (fix en 0040): `app.revoke_all_refresh_tokens` ahora exige
    // autorrevocación (`current_user_id() = p_user_id`) o superadmin -- se
    // fija el contexto propio del usuario antes de invocarla.
    await asActor(db, { userId }, (tx) => tx.query('select app.revoke_all_refresh_tokens($1)', [userId]));
    for (const h of hashes) {
      const row = await db.query<{ revoked_at: string | null }>('select revoked_at from app.find_refresh_token($1)', [
        h,
      ]);
      expect(row.rows[0]?.revoked_at).not.toBeNull();
    }
  });

  it('app.accept_invitation: acepta una invitación pendiente cuyo email coincide con el usuario y crea la membresía', async () => {
    const org = await seedOrg(db, 'accept-inv-org');
    await seedMember(db, org.orgId, 'inviter@example.com', 'owner');
    const invitedUserId = await seedUser(db, 'invited@example.com');
    const tokenHash = createHash('sha256').update('invite-token-1').digest('hex');

    await db.query(
      `insert into invitations (org_id, email, role, token_hash, expires_at)
       values ($1, 'invited@example.com', 'writer', $2, now() + interval '7 days')`,
      [org.orgId, tokenHash]
    );

    const result = await db.query<{ out_org_id: string; out_role: string }>(
      'select * from app.accept_invitation($1, $2)',
      [tokenHash, invitedUserId]
    );
    expect(result.rows[0]?.out_org_id).toBe(org.orgId);
    expect(result.rows[0]?.out_role).toBe('writer');

    const membership = await db.query<{ role: string }>(
      'select role from memberships where org_id = $1 and user_id = $2',
      [org.orgId, invitedUserId]
    );
    expect(membership.rows[0]?.role).toBe('writer');

    const invitation = await db.query<{ status: string }>('select status from invitations where token_hash = $1', [
      tokenHash,
    ]);
    expect(invitation.rows[0]?.status).toBe('accepted');
  });

  it('app.accept_invitation rechaza si el email del usuario no coincide con el de la invitación', async () => {
    const org = await seedOrg(db, 'accept-inv-mismatch-org');
    await seedMember(db, org.orgId, 'inviter2@example.com', 'owner');
    const wrongUserId = await seedUser(db, 'not-invited@example.com');
    const tokenHash = createHash('sha256').update('invite-token-mismatch').digest('hex');

    await db.query(
      `insert into invitations (org_id, email, role, token_hash, expires_at)
       values ($1, 'someone-else@example.com', 'writer', $2, now() + interval '7 days')`,
      [org.orgId, tokenHash]
    );

    await expect(db.query('select * from app.accept_invitation($1, $2)', [tokenHash, wrongUserId])).rejects.toThrow(
      /invitation_email_mismatch/
    );
  });

  it('app.accept_invitation rechaza una invitación ya expirada', async () => {
    const org = await seedOrg(db, 'accept-inv-expired-org');
    const userId = await seedUser(db, 'expired-invitee@example.com');
    const tokenHash = createHash('sha256').update('invite-token-expired').digest('hex');

    await db.query(
      `insert into invitations (org_id, email, role, token_hash, expires_at)
       values ($1, 'expired-invitee@example.com', 'viewer', $2, now() - interval '1 day')`,
      [org.orgId, tokenHash]
    );

    await expect(db.query('select * from app.accept_invitation($1, $2)', [tokenHash, userId])).rejects.toThrow(
      /invitation_expired/
    );
    // La función no puede persistir la transición a 'expired' (raise revierte
    // la llamada completa); queda en 'pending' con expires_at en el pasado,
    // y es la capa de aplicación (apps/api) la que la presenta como expirada
    // comparando expires_at contra la fecha actual (ver test de apps/api).
    const invitation = await db.query<{ status: string }>('select status from invitations where token_hash = $1', [
      tokenHash,
    ]);
    expect(invitation.rows[0]?.status).toBe('pending');
  });

  it('approved_rates: un writer puede proponer (INSERT) una tarifa en borrador, pero no aprobarla (UPDATE)', async () => {
    const org = await seedOrg(db, 'rates-propose-org');
    const writerId = await seedMember(db, org.orgId, 'writer-rates@example.com', 'writer');

    const inserted = await asActor(db, { orgId: org.orgId, userId: writerId }, (tx) =>
      tx.query<{ id: string }>(
        "insert into approved_rates (org_id, item_code, description, unit_price, status) values ($1, 'W-1', 'desc', 10, 'draft') returning id",
        [org.orgId]
      )
    );
    expect(inserted.rows.length).toBe(1);
    const rateId = inserted.rows[0].id;

    // El mismo writer NO puede aprobarla (UPDATE reservado a decision_roles: owner/admin/analyst).
    const approveAttempt = await asActor(db, { orgId: org.orgId, userId: writerId }, (tx) =>
      tx.query("update approved_rates set status = 'approved' where id = $1", [rateId])
    );
    expect(approveAttempt.rowCount).toBe(0);

    const ownerId = await seedMember(db, org.orgId, 'owner-rates@example.com', 'owner');
    const approved = await asActor(db, { orgId: org.orgId, userId: ownerId }, (tx) =>
      tx.query("update approved_rates set status = 'approved' where id = $1", [rateId])
    );
    expect(approved.rowCount).toBe(1);
  });

  it('agent_runs: acepta los nuevos valores de estado y las columnas de ronda 2 (actor, correlación, costo)', async () => {
    const org = await seedOrg(db, 'agent-runs-ronda2-org');
    const userId = await seedMember(db, org.orgId, 'agent-actor@example.com', 'writer');

    const inserted = await asActor(db, { orgId: org.orgId, userId }, (tx) =>
      tx.query<{ id: string; status: string }>(
        `insert into agent_runs (org_id, agent_name, actor_id, actor_role, status, total_steps, correlation_id, estimated_cost_usd)
         values ($1, 'redactor', $2, 'writer', 'in_progress', 3, 'tender-123', 0.42)
         returning id, status`,
        [org.orgId, userId]
      )
    );
    expect(inserted.rows[0]?.status).toBe('in_progress');

    const updated = await asActor(db, { orgId: org.orgId, userId }, (tx) =>
      tx.query<{ status: string; completed_steps: number }>(
        "update agent_runs set status = 'needs_approval', pending_step_index = 1 where id = $1 returning status, completed_steps",
        [inserted.rows[0].id]
      )
    );
    expect(updated.rows[0]?.status).toBe('needs_approval');
  });

  it('incidents: RLS por organización (superadmin edita, la organización solo reporta y lee lo suyo)', async () => {
    const org = await seedOrg(db, 'incidents-org');
    const writerId = await seedMember(db, org.orgId, 'incident-writer@example.com', 'writer');
    const superadminUser = await seedUser(db, 'incident-superadmin@example.com');
    await db.query('insert into platform_admins (user_id) values ($1)', [superadminUser]);

    const created = await asActor(db, { orgId: org.orgId, userId: writerId }, (tx) =>
      tx.query<{ id: string }>("insert into incidents (org_id, title, severity) values ($1, 'Fuente caída', 'high') returning id", [
        org.orgId,
      ])
    );
    const incidentId = created.rows[0].id;

    // La organización no puede resolver su propio incidente (reservado a superadmin/back office).
    const orgResolveAttempt = await asActor(db, { orgId: org.orgId, userId: writerId }, (tx) =>
      tx.query("update incidents set status = 'resolved' where id = $1", [incidentId])
    );
    expect(orgResolveAttempt.rowCount).toBe(0);

    const superadminResolve = await asActor(db, {}, (tx) =>
      tx.query("update incidents set status = 'resolved' where id = $1", [incidentId])
    );
    // Sin current_user_id fijado como superadmin no debería aplicar; fijamos el contexto correcto:
    expect(superadminResolve.rowCount).toBe(0);

    const superadminResolveOk = await asActor(db, { userId: superadminUser }, (tx) =>
      tx.query("update incidents set status = 'resolved' where id = $1", [incidentId])
    );
    expect(superadminResolveOk.rowCount).toBe(1);
  });
});
