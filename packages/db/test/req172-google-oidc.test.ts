import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedUser, seedOrg, asActor } from './helpers.js';

/**
 * REQ-172..180 (docs/REQUISITOS.md §34.1, 0071_req172_google_oidc.sql /
 * 0072_req177_google_auth_audit.sql): pruebas de esquema/funciones a nivel
 * de base de datos para el login con Google -- independientes de
 * `apps/api` (que las ejerce indirectamente en
 * `apps/api/test/google-oidc-login.test.ts` con un proveedor OIDC falso
 * real end-to-end).
 */
describe('REQ-172..180: esquema y funciones SECURITY DEFINER de Google OIDC', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('users.password_hash es NULLABLE (cuenta creada solo por Google, sin contraseña propia)', async () => {
    const { rows } = await db.query<{ id: string }>(
      "insert into users (email, password_hash) values ('google-only@example.com', null) returning id"
    );
    expect(rows.length).toBe(1);
    const check = await db.query<{ password_hash: string | null }>('select password_hash from users where id = $1', [rows[0].id]);
    expect(check.rows[0].password_hash).toBeNull();
  });

  describe('oauth_states: create/consume de un solo uso con TTL', () => {
    it('app.consume_oauth_state consume UNA vez y devuelve 0 filas en el segundo intento', async () => {
      const id = randomUUID();
      await asActor(db, {}, (tx) =>
        tx.query(
          "select app.create_oauth_state($1, 'google', 'verifier-1', 'nonce-1', 'https://app.example.test/callback', now() + interval '10 minutes')",
          [id]
        )
      );

      const first = await asActor(db, {}, (tx) => tx.query('select * from app.consume_oauth_state($1)', [id]));
      expect(first.rows.length).toBe(1);
      expect(first.rows[0].code_verifier).toBe('verifier-1');
      expect(first.rows[0].nonce).toBe('nonce-1');

      const second = await asActor(db, {}, (tx) => tx.query('select * from app.consume_oauth_state($1)', [id]));
      expect(second.rows.length).toBe(0);
    });

    it('app.consume_oauth_state rechaza una fila ya expirada (TTL vencido)', async () => {
      const id = randomUUID();
      await asActor(db, {}, (tx) =>
        tx.query(
          "select app.create_oauth_state($1, 'google', 'verifier-2', 'nonce-2', 'https://app.example.test/callback', now() - interval '1 minute')",
          [id]
        )
      );
      const result = await asActor(db, {}, (tx) => tx.query('select * from app.consume_oauth_state($1)', [id]));
      expect(result.rows.length).toBe(0);
    });

    it('un id desconocido devuelve 0 filas (nunca lanza excepción)', async () => {
      const result = await asActor(db, {}, (tx) => tx.query('select * from app.consume_oauth_state($1)', [randomUUID()]));
      expect(result.rows.length).toBe(0);
    });
  });

  describe('app.find_identity_by_subject: análogo pre-sesión a find_user_by_email', () => {
    it('DB-01-style: rechaza ejecutarse si ya hay una sesión fijada (current_user_id no nulo)', async () => {
      const userId = await seedUser(db, 'find-identity-session@example.com');
      await expect(
        asActor(db, { userId }, (tx) => tx.query("select * from app.find_identity_by_subject('google', 'sub-x')"))
      ).rejects.toThrow(/find_identity_by_subject_not_allowed_in_session_context/);
    });

    it('pre-sesión: encuentra la identidad vinculada por (provider, subject)', async () => {
      const userId = await seedUser(db, 'find-identity-ok@example.com');
      await asActor(db, { userId }, (tx) =>
        tx.query('insert into user_identities (user_id, provider, subject, email) values ($1, $2, $3, $4)', [
          userId,
          'google',
          'sub-ok-1',
          'find-identity-ok@example.com',
        ])
      );

      const found = await asActor(db, {}, (tx) => tx.query('select * from app.find_identity_by_subject($1, $2)', ['google', 'sub-ok-1']));
      expect(found.rows.length).toBe(1);
      expect(found.rows[0].user_id).toBe(userId);
      expect(found.rows[0].is_active).toBe(true);
    });

    it('pre-sesión: subject desconocido devuelve 0 filas', async () => {
      const found = await asActor(db, {}, (tx) => tx.query("select * from app.find_identity_by_subject('google', 'subject-que-no-existe')"));
      expect(found.rows.length).toBe(0);
    });
  });

  describe('user_identities: RLS por propio usuario (mismo patrón que user_totp_secrets)', () => {
    it('un usuario NO puede ver la identidad vinculada de OTRO usuario', async () => {
      const userA = await seedUser(db, 'identities-rls-a@example.com');
      const userB = await seedUser(db, 'identities-rls-b@example.com');
      await asActor(db, { userId: userA }, (tx) =>
        tx.query('insert into user_identities (user_id, provider, subject, email) values ($1, $2, $3, $4)', [
          userA,
          'google',
          'sub-rls-a',
          'identities-rls-a@example.com',
        ])
      );

      const asA = await asActor(db, { userId: userA }, (tx) => tx.query('select * from user_identities where user_id = $1', [userA]));
      expect(asA.rows.length).toBe(1);

      const asB = await asActor(db, { userId: userB }, (tx) => tx.query('select * from user_identities where user_id = $1', [userA]));
      expect(asB.rows.length).toBe(0);
    });

    it('un usuario NO puede insertar una identidad para OTRO usuario (política de INSERT)', async () => {
      const userA = await seedUser(db, 'identities-rls-insert-a@example.com');
      const userB = await seedUser(db, 'identities-rls-insert-b@example.com');
      await expect(
        asActor(db, { userId: userA }, (tx) =>
          tx.query('insert into user_identities (user_id, provider, subject, email) values ($1, $2, $3, $4)', [
            userB,
            'google',
            'sub-rls-insert-hostil',
            'identities-rls-insert-b@example.com',
          ])
        )
      ).rejects.toThrow();
    });
  });

  describe('app.accept_pending_invitations_for_user: acepta invitaciones pendientes del email YA VERIFICADO del propio usuario', () => {
    it('ATAQUE: rechaza si el actor no coincide con p_user_id (anti-forjado, mismo criterio que 0054/API-14)', async () => {
      const attacker = await seedUser(db, 'accept-inv-attacker@example.com');
      const victim = await seedUser(db, 'accept-inv-victim@example.com');
      await expect(
        asActor(db, { userId: attacker }, (tx) => tx.query('select * from app.accept_pending_invitations_for_user($1)', [victim]))
      ).rejects.toThrow(/accept_pending_invitations_actor_mismatch/);
    });

    it('sin sesión fijada, también rechaza (nunca "abierto" por falta de contexto)', async () => {
      const userId = await seedUser(db, 'accept-inv-nosession@example.com');
      await expect(asActor(db, {}, (tx) => tx.query('select * from app.accept_pending_invitations_for_user($1)', [userId]))).rejects.toThrow(
        /accept_pending_invitations_actor_mismatch/
      );
    });

    it('acepta TODAS las invitaciones pendientes y no expiradas del email del usuario, marca la invitación aceptada e inserta la membresía', async () => {
      const email = 'accept-inv-multi@example.com';
      const org1 = await seedOrg(db, `accept-inv-org1-${Date.now()}`);
      const org2 = await seedOrg(db, `accept-inv-org2-${Date.now()}`);
      await db.query(
        "insert into invitations (org_id, email, role, token_hash, expires_at) values ($1, $2, 'viewer', 'hash-1', now() + interval '7 days')",
        [org1.orgId, email]
      );
      await db.query(
        "insert into invitations (org_id, email, role, token_hash, expires_at) values ($1, $2, 'admin', 'hash-2', now() + interval '7 days')",
        [org2.orgId, email]
      );
      // Invitación YA EXPIRADA para el mismo email -- nunca debe aceptarse.
      const orgExpired = await seedOrg(db, `accept-inv-org-expired-${Date.now()}`);
      await db.query(
        "insert into invitations (org_id, email, role, token_hash, expires_at) values ($1, $2, 'viewer', 'hash-3', now() - interval '1 day')",
        [orgExpired.orgId, email]
      );

      const userId = await seedUser(db, email);
      const accepted = await asActor(db, { userId }, (tx) => tx.query('select * from app.accept_pending_invitations_for_user($1)', [userId]));
      expect(accepted.rows.length).toBe(2);

      const memberships = await db.query<{ org_id: string; role: string }>('select org_id, role from memberships where user_id = $1 order by org_id', [userId]);
      expect(memberships.rows.map((r) => r.org_id).sort()).toEqual([org1.orgId, org2.orgId].sort());

      const invitationStatuses = await db.query<{ status: string }>('select status from invitations where email = $1 and org_id in ($2, $3)', [
        email,
        org1.orgId,
        org2.orgId,
      ]);
      expect(invitationStatuses.rows.every((r) => r.status === 'accepted')).toBe(true);

      const expiredStatus = await db.query<{ status: string }>('select status from invitations where org_id = $1', [orgExpired.orgId]);
      expect(expiredStatus.rows[0].status).toBe('pending');
      const noMembership = await db.query('select 1 from memberships where org_id = $1 and user_id = $2', [orgExpired.orgId, userId]);
      expect(noMembership.rows.length).toBe(0);
    });

    it('sin ninguna invitación pendiente para ese email, devuelve 0 filas (nunca lanza)', async () => {
      const userId = await seedUser(db, 'accept-inv-none@example.com');
      const accepted = await asActor(db, { userId }, (tx) => tx.query('select * from app.accept_pending_invitations_for_user($1)', [userId]));
      expect(accepted.rows.length).toBe(0);
    });
  });

  describe('app.record_auth_event: nuevas acciones de Google (0072)', () => {
    it('auth.google_login/auth.google_linked exigen actor coincidente con la sesión (igual que login_succeeded)', async () => {
      const attacker = await seedUser(db, 'record-google-attacker@example.com');
      const victim = await seedUser(db, 'record-google-victim@example.com');
      for (const action of ['auth.google_login', 'auth.google_linked']) {
        await expect(
          asActor(db, { userId: attacker }, (tx) => tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', [action, victim, '{}', 'req']))
        ).rejects.toThrow(/record_auth_event_actor_mismatch/);
      }
    });

    it('auth.google_login/auth.google_linked SÍ se registran cuando el actor coincide con la sesión', async () => {
      const userId = await seedUser(db, 'record-google-ok@example.com');
      for (const action of ['auth.google_login', 'auth.google_linked']) {
        await asActor(db, { userId }, (tx) => tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', [action, userId, '{}', 'req']));
      }
      const rows = await db.query('select action from audit_log where actor_id = $1 order by action', [userId]);
      expect(rows.rows.map((r: any) => r.action)).toEqual(['auth.google_linked', 'auth.google_login']);
    });

    it('auth.google_rejected funciona SIN sesión previa y con actor_id NULL (mismo criterio que login_failed)', async () => {
      await asActor(db, {}, (tx) => tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', ['auth.google_rejected', null, '{}', 'req-rej']));
      const rows = await db.query("select 1 from audit_log where actor_id is null and action = 'auth.google_rejected'");
      expect(rows.rows.length).toBeGreaterThan(0);
    });

    it('sigue rechazando cualquier acción fuera de la lista cerrada', async () => {
      const userId = await seedUser(db, 'record-google-invalid-action@example.com');
      await expect(
        asActor(db, { userId }, (tx) => tx.query('select app.record_auth_event($1, $2, $3::jsonb, $4)', ['auth.google_hacked', userId, '{}', 'req']))
      ).rejects.toThrow(/record_auth_event_accion_no_permitida/);
    });
  });
});
