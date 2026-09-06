import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, seedUser, asActor } from './helpers.js';

/**
 * REQ-181..195 (docs/REQUISITOS.md §34.2, 0080-0084): pruebas de esquema/
 * funciones SECURITY DEFINER a nivel de base de datos para el outbox de
 * correo, supresión, anti-replay de webhooks, preferencias de notificación
 * y verificación de correo/restablecimiento de contraseña -- independientes
 * de apps/api (que las ejerce indirectamente en apps/api/test/mail-*.test.ts
 * con CaptureProvider real end-to-end).
 */
describe('REQ-181..195: esquema y funciones SECURITY DEFINER de correo', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  describe('mail_outbox: reserve()/get()/save()/release()', () => {
    it('reserve() gana la primera vez y pierde mientras la reserva sigue viva (concurrencia real)', async () => {
      const key = `dedupe-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          asActor(db, {}, (tx) =>
            tx.query('select app.mail_outbox_reserve($1, $2, 5, null, null, $3) as id', [key, 'email-verification', 'user@example.com'])
          )
        )
      );
      const won = results.filter((r) => r.rows[0]?.id !== null);
      expect(won.length).toBe(1);
    });

    it('get() no devuelve una fila pending (solo estados finales)', async () => {
      const key = `dedupe-${randomUUID()}`;
      await asActor(db, {}, (tx) => tx.query('select app.mail_outbox_reserve($1, $2, 5, null, null, null)', [key, 'password-reset']));
      const pending = await asActor(db, {}, (tx) => tx.query('select * from app.mail_outbox_get($1)', [key]));
      expect(pending.rows.length).toBe(0);

      await asActor(db, {}, (tx) =>
        tx.query("select app.mail_outbox_save($1, 'sent', 'provider-msg-1', 1, 5, null)", [key])
      );
      const sent = await asActor(db, {}, (tx) => tx.query('select * from app.mail_outbox_get($1)', [key]));
      expect(sent.rows.length).toBe(1);
      expect(sent.rows[0].status).toBe('sent');
      expect(sent.rows[0].provider_message_id).toBe('provider-msg-1');
    });

    it('save() rechaza un estado que no es final (nunca deja guardar "pending" a mano)', async () => {
      const key = `dedupe-${randomUUID()}`;
      await asActor(db, {}, (tx) => tx.query('select app.mail_outbox_reserve($1, $2, 5, null, null, null)', [key, 'password-reset']));
      await expect(
        asActor(db, {}, (tx) => tx.query("select app.mail_outbox_save($1, 'pending', null, 1, 5, null)", [key]))
      ).rejects.toThrow(/mail_outbox_save_estado_no_permitido/);
    });

    it('release() permite reclamar la reserva de inmediato en un reintento posterior', async () => {
      const key = `dedupe-${randomUUID()}`;
      const first = await asActor(db, {}, (tx) =>
        tx.query('select app.mail_outbox_reserve($1, $2, 5, null, null, null) as id', [key, 'password-reset'])
      );
      expect(first.rows[0].id).not.toBeNull();

      await asActor(db, {}, (tx) => tx.query('select app.mail_outbox_release($1)', [key]));

      const second = await asActor(db, {}, (tx) =>
        tx.query('select app.mail_outbox_reserve($1, $2, 5, null, null, null) as id', [key, 'password-reset'])
      );
      expect(second.rows[0].id).not.toBeNull();
    });

    it('mail_outbox_peek exige superadmin', async () => {
      const key = `dedupe-${randomUUID()}`;
      await asActor(db, {}, (tx) => tx.query('select app.mail_outbox_reserve($1, $2, 5, null, null, null)', [key, 'password-reset']));
      const userId = await seedUser(db, `no-admin-${randomUUID()}@example.com`);
      await expect(
        asActor(db, { userId }, (tx) => tx.query('select * from app.mail_outbox_peek($1)', [key]))
      ).rejects.toThrow(/mail_outbox_peek_requiere_superadmin/);
    });
  });

  describe('mail_suppressions: deny-all', () => {
    it('check/add/get/remove operan sobre el email normalizado (minúsculas, sin espacios)', async () => {
      const email = `  Bounce-${randomUUID()}@Example.com `;
      const before = await asActor(db, {}, (tx) => tx.query('select app.mail_suppression_check($1) as suppressed', [email]));
      expect(before.rows[0].suppressed).toBe(false);

      await asActor(db, {}, (tx) => tx.query("select app.mail_suppression_add($1, 'bounce', 'webhook_resend')", [email]));

      const after = await asActor(db, {}, (tx) => tx.query('select app.mail_suppression_check($1) as suppressed', [email.toUpperCase()]));
      expect(after.rows[0].suppressed).toBe(true);

      const entry = await asActor(db, {}, (tx) => tx.query('select * from app.mail_suppression_get($1)', [email]));
      expect(entry.rows[0].reason).toBe('bounce');

      await asActor(db, {}, (tx) => tx.query('select app.mail_suppression_remove($1)', [email]));
      const removed = await asActor(db, {}, (tx) => tx.query('select app.mail_suppression_check($1) as suppressed', [email]));
      expect(removed.rows[0].suppressed).toBe(false);
    });
  });

  describe('mail_webhook_claim: anti-replay por svix_id', () => {
    it('la primera llamada gana (true), la segunda con el mismo svix_id es un replay (false)', async () => {
      const svixId = `msg_${randomUUID()}`;
      const first = await asActor(db, {}, (tx) => tx.query('select app.mail_webhook_claim($1, 300) as claimed', [svixId]));
      expect(first.rows[0].claimed).toBe(true);
      const second = await asActor(db, {}, (tx) => tx.query('select app.mail_webhook_claim($1, 300) as claimed', [svixId]));
      expect(second.rows[0].claimed).toBe(false);
    });
  });

  describe('notification_preferences: propia fila + baja de un clic', () => {
    it('cada usuario solo ve/edita su propia fila', async () => {
      const userA = await seedUser(db, `pref-a-${randomUUID()}@example.com`);
      const userB = await seedUser(db, `pref-b-${randomUUID()}@example.com`);
      await asActor(db, { userId: userA }, (tx) =>
        tx.query('insert into notification_preferences (user_id, weekly_summary) values ($1, false)', [userA])
      );
      const bSees = await asActor(db, { userId: userB }, (tx) => tx.query('select * from notification_preferences where user_id = $1', [userA]));
      expect(bSees.rows.length).toBe(0);
      const aSees = await asActor(db, { userId: userA }, (tx) => tx.query('select * from notification_preferences where user_id = $1', [userA]));
      expect(aSees.rows.length).toBe(1);
      expect(aSees.rows[0].weekly_summary).toBe(false);
    });

    it('set_notification_preference_unsigned crea la fila perezosamente y apaga solo la categoría pedida', async () => {
      const userId = await seedUser(db, `pref-unsub-${randomUUID()}@example.com`);
      await asActor(db, {}, (tx) => tx.query("select app.set_notification_preference_unsigned($1, 'weekly_summary', false)", [userId]));
      const row = await asActor(db, { userId }, (tx) => tx.query('select * from notification_preferences where user_id = $1', [userId]));
      expect(row.rows[0].weekly_summary).toBe(false);
      expect(row.rows[0].deadlines).toBe(true);
    });

    it('rechaza una categoría desconocida', async () => {
      const userId = await seedUser(db, `pref-bad-${randomUUID()}@example.com`);
      await expect(
        asActor(db, {}, (tx) => tx.query("select app.set_notification_preference_unsigned($1, 'no_existe', false)", [userId]))
      ).rejects.toThrow(/set_notification_preference_categoria_no_permitida/);
    });
  });

  describe('email_verification_tokens: consumo de un solo uso', () => {
    it('consume_email_verification_token marca users.email_verified_at y es de un solo uso', async () => {
      const userId = await seedUser(db, `verify-${randomUUID()}@example.com`);
      const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
      await asActor(db, {}, (tx) =>
        tx.query("select app.create_email_verification_token($1, $2, $3, now() + interval '30 minutes')", [randomUUID(), userId, tokenHash])
      );

      const before = await db.query<{ email_verified_at: string | null }>('select email_verified_at from users where id = $1', [userId]);
      expect(before.rows[0].email_verified_at).toBeNull();

      const first = await asActor(db, {}, (tx) => tx.query('select * from app.consume_email_verification_token($1)', [tokenHash]));
      expect(first.rows[0].out_user_id).toBe(userId);

      const after = await db.query<{ email_verified_at: string | null }>('select email_verified_at from users where id = $1', [userId]);
      expect(after.rows[0].email_verified_at).not.toBeNull();

      const second = await asActor(db, {}, (tx) => tx.query('select * from app.consume_email_verification_token($1)', [tokenHash]));
      expect(second.rows.length).toBe(0);
    });

    it('rechaza un token expirado', async () => {
      const userId = await seedUser(db, `verify-exp-${randomUUID()}@example.com`);
      const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
      await asActor(db, {}, (tx) =>
        tx.query("select app.create_email_verification_token($1, $2, $3, now() - interval '1 minute')", [randomUUID(), userId, tokenHash])
      );
      const result = await asActor(db, {}, (tx) => tx.query('select * from app.consume_email_verification_token($1)', [tokenHash]));
      expect(result.rows.length).toBe(0);
    });
  });

  describe('password_reset_tokens: consumo de un solo uso + revocación de sesiones', () => {
    it('reset_password_with_token cambia password_hash, revoca refresh tokens y es de un solo uso', async () => {
      const userId = await seedUser(db, `reset-${randomUUID()}@example.com`);
      const refreshId = randomUUID();
      await asActor(db, { userId }, (tx) =>
        tx.query("select app.create_refresh_token($1, $2, 'hash-abc', now() + interval '30 days')", [refreshId, userId])
      );

      const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
      await asActor(db, {}, (tx) =>
        tx.query("select app.create_password_reset_token($1, $2, $3, now() + interval '30 minutes')", [randomUUID(), userId, tokenHash])
      );

      const result = await asActor(db, {}, (tx) => tx.query('select * from app.reset_password_with_token($1, $2)', [tokenHash, 'scrypt:new-hash']));
      expect(result.rows[0].out_user_id).toBe(userId);

      const user = await db.query<{ password_hash: string }>('select password_hash from users where id = $1', [userId]);
      expect(user.rows[0].password_hash).toBe('scrypt:new-hash');

      const refresh = await asActor(db, {}, (tx) => tx.query('select * from app.find_refresh_token($1)', ['hash-abc']));
      expect(refresh.rows[0].revoked_at).not.toBeNull();

      const second = await asActor(db, {}, (tx) => tx.query('select * from app.reset_password_with_token($1, $2)', [tokenHash, 'scrypt:other-hash']));
      expect(second.rows.length).toBe(0);
      const stillOld = await db.query<{ password_hash: string }>('select password_hash from users where id = $1', [userId]);
      expect(stillOld.rows[0].password_hash).toBe('scrypt:new-hash');
    });
  });

  describe('contact_requests: inserción pública, lectura solo superadmin', () => {
    it('cualquiera (sin sesión) puede insertar; solo superadmin puede listar', async () => {
      await asActor(db, {}, (tx) =>
        tx.query(
          "insert into contact_requests (name, email, message, ip) values ('Ana', 'ana@example.com', 'Hola', '127.0.0.1')"
        )
      );
      const userId = await seedUser(db, `no-admin-contact-${randomUUID()}@example.com`);
      const denied = await asActor(db, { userId }, (tx) => tx.query('select * from contact_requests'));
      expect(denied.rows.length).toBe(0);
    });
  });

  describe('record_auth_event: nuevas acciones de correo', () => {
    it('auth.password_reset_requested no exige sesión (pre-autenticación)', async () => {
      await asActor(db, {}, (tx) => tx.query("select app.record_auth_event('auth.password_reset_requested', null, '{}'::jsonb, null)"));
    });

    it('auth.password_reset_completed exige que current_user_id coincida con el actor', async () => {
      const userId = await seedUser(db, `audit-reset-${randomUUID()}@example.com`);
      await expect(
        asActor(db, {}, (tx) => tx.query("select app.record_auth_event('auth.password_reset_completed', $1, '{}'::jsonb, null)", [userId]))
      ).rejects.toThrow(/record_auth_event_actor_mismatch/);

      await asActor(db, { userId }, (tx) =>
        tx.query("select app.record_auth_event('auth.password_reset_completed', $1, '{}'::jsonb, null)", [userId])
      );
    });

    it('rechaza una acción desconocida', async () => {
      await expect(
        asActor(db, {}, (tx) => tx.query("select app.record_auth_event('auth.algo_inventado', null, '{}'::jsonb, null)"))
      ).rejects.toThrow(/record_auth_event_accion_no_permitida/);
    });
  });
});
