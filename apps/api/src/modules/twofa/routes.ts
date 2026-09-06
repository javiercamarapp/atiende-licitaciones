/**
 * REQ-044/064: enrolamiento y verificación TOTP (2FA/step-up) para
 * aprobaciones económicas sensibles. Endpoints de USUARIO (no requieren
 * organización activa -- el enrolamiento es de la cuenta, válido para
 * cualquier organización de la que el usuario sea miembro).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { recordSecurityAudit } from '../../lib/audit.js';
import { ConflictError, ForbiddenError } from '../../lib/errors.js';
import {
  encryptSecret,
  decryptSecret,
  generateTotpEnrollment,
  generateBackupCodes,
  hashBackupCode,
  verifyTotpCode,
  assertSixDigitCode,
} from '../../lib/step-up.js';
import { enrollResponseSchema, totpCodeSchema, verifyEnrollmentResponseSchema, stepUpResponseSchema, stepUpStatusResponseSchema } from './schemas.js';

/** Un código de respaldo tiene forma "XXXX-XXXX"; cualquier otra cosa se intenta como TOTP de 6 dígitos. */
function looksLikeBackupCode(code: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code.trim());
}

export async function twofaRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/2fa/status',
    { preHandler: [app.authenticate], schema: { response: { 200: stepUpStatusResponseSchema } } },
    async (request) => {
      const userId = request.userId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        return tx.query<{ verified_at: string | Date | null; enrolled_at: string | Date }>(
          'select verified_at, enrolled_at from user_totp_secrets where user_id = $1',
          [userId]
        );
      });
      if (rows.length === 0 || rows[0].verified_at === null) return { enrolled: false, enrolledAt: null };
      return { enrolled: true, enrolledAt: rows[0].enrolled_at };
    }
  );

  server.post(
    '/2fa/enroll',
    { preHandler: [app.authenticate], schema: { response: { 201: enrollResponseSchema } } },
    async (request, reply) => {
      const userId = request.userId!;
      const result = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        const existing = await tx.query<{ verified_at: string | Date | null }>('select verified_at from user_totp_secrets where user_id = $1', [userId]);
        if (existing.rows.length > 0 && existing.rows[0].verified_at !== null) {
          throw new ConflictError('Este usuario ya tiene 2FA enrolado y verificado. No se permite re-enrolar sin antes desenrolar (fuera de alcance de esta ronda -- contacte a un administrador).');
        }

        const userRes = await tx.query<{ email: string }>('select email from users where id = $1', [userId]);
        const email = userRes.rows[0]?.email ?? userId;

        const enrollment = generateTotpEnrollment(email);
        const ciphertext = encryptSecret(enrollment.secretBase32, app.config.totpEncryptionKey);

        await tx.query(
          `insert into user_totp_secrets (id, user_id, secret_ciphertext, enrolled_at, verified_at, last_used_time_step)
           values ($1, $2, $3, now(), null, null)
           on conflict (user_id) do update set secret_ciphertext = excluded.secret_ciphertext, enrolled_at = now(), verified_at = null, last_used_time_step = null`,
          [randomUUID(), userId, ciphertext]
        );

        // Códigos de respaldo: se REEMPLAZAN por completo en cada
        // (re)enrolamiento -- nunca se acumulan códigos de un secreto
        // anterior que ya no aplica.
        await tx.query('delete from user_backup_codes where user_id = $1', [userId]);
        const backupCodes = generateBackupCodes(10);
        for (const code of backupCodes) {
          await tx.query('insert into user_backup_codes (id, user_id, code_hash) values ($1, $2, $3)', [randomUUID(), userId, hashBackupCode(code)]);
        }

        await recordSecurityAudit(tx, {
          actorId: userId,
          action: 'twofa.enroll',
          entity: 'user_totp_secrets',
          entityId: userId,
          after: { backupCodesIssued: backupCodes.length },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return { secretBase32: enrollment.secretBase32, otpauthUrl: enrollment.otpauthUrl, backupCodes };
      });
      reply.code(201);
      return result;
    }
  );

  server.post(
    '/2fa/verify-enrollment',
    { preHandler: [app.authenticate], schema: { body: totpCodeSchema, response: { 200: verifyEnrollmentResponseSchema } } },
    async (request) => {
      const userId = request.userId!;
      const code = assertSixDigitCode(request.body.code);
      return app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        const row = await tx.query<{ secret_ciphertext: string; last_used_time_step: string | number | null }>(
          'select secret_ciphertext, last_used_time_step from user_totp_secrets where user_id = $1',
          [userId]
        );
        if (row.rows.length === 0) {
          throw new ForbiddenError('No hay un enrolamiento de 2FA pendiente para este usuario. Llame primero a POST /auth/2fa/enroll.');
        }
        const secret = decryptSecret(row.rows[0].secret_ciphertext, app.config.totpEncryptionKey);
        const verification = await verifyTotpCode(secret, code);
        const lastUsed = row.rows[0].last_used_time_step === null ? null : Number(row.rows[0].last_used_time_step);
        if (!verification.valid || (lastUsed !== null && verification.timeStep <= lastUsed)) {
          throw new ForbiddenError('Código TOTP inválido o ya utilizado (replay rechazado).');
        }

        await tx.query('update user_totp_secrets set verified_at = now(), last_used_time_step = $1 where user_id = $2', [verification.timeStep, userId]);

        // Confirmar el enrolamiento ya prueba posesión del TOTP -- se
        // emite de una vez una sesión de step-up (ver docstring del schema).
        const stepUpId = randomUUID();
        const expiresAt = new Date(Date.now() + app.config.stepUpWindowMinutes * 60_000).toISOString();
        await tx.query('insert into step_up_sessions (id, user_id, verified_at, expires_at) values ($1, $2, now(), $3)', [stepUpId, userId, expiresAt]);

        await recordSecurityAudit(tx, {
          actorId: userId,
          action: 'twofa.verify_enrollment',
          entity: 'user_totp_secrets',
          entityId: userId,
          after: { verified: true },
          requestId: request.id,
          correlationId: request.correlationId,
        });
        return { enrolled: true as const, stepUpToken: stepUpId, expiresAt };
      });
    }
  );

  server.post(
    '/2fa/step-up',
    {
      preHandler: [app.authenticate],
      schema: { body: totpCodeSchema, response: { 201: stepUpResponseSchema } },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const rawCode = request.body.code.trim();

      const result = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        const totpRow = await tx.query<{ secret_ciphertext: string; verified_at: string | Date | null; last_used_time_step: string | number | null }>(
          'select secret_ciphertext, verified_at, last_used_time_step from user_totp_secrets where user_id = $1',
          [userId]
        );
        if (totpRow.rows.length === 0 || totpRow.rows[0].verified_at === null) {
          throw new ForbiddenError('Este usuario no tiene 2FA enrolado y verificado. Enrole primero con POST /auth/2fa/enroll y confirme con POST /auth/2fa/verify-enrollment.');
        }

        if (looksLikeBackupCode(rawCode)) {
          const codeHash = hashBackupCode(rawCode);
          const backupRow = await tx.query<{ id: string }>(
            'select id from user_backup_codes where user_id = $1 and code_hash = $2 and used_at is null',
            [userId, codeHash]
          );
          if (backupRow.rows.length === 0) {
            throw new ForbiddenError('Código de respaldo inválido o ya utilizado.');
          }
          await tx.query('update user_backup_codes set used_at = now() where id = $1', [backupRow.rows[0].id]);
        } else {
          const code = assertSixDigitCode(rawCode);
          const secret = decryptSecret(totpRow.rows[0].secret_ciphertext, app.config.totpEncryptionKey);
          const verification = await verifyTotpCode(secret, code);
          const lastUsed = totpRow.rows[0].last_used_time_step === null ? null : Number(totpRow.rows[0].last_used_time_step);
          if (!verification.valid || (lastUsed !== null && verification.timeStep <= lastUsed)) {
            throw new ForbiddenError('Código TOTP inválido, o ya fue utilizado (replay rechazado).');
          }
          await tx.query('update user_totp_secrets set last_used_time_step = $1 where user_id = $2', [verification.timeStep, userId]);
        }

        const id = randomUUID();
        const expiresAt = new Date(Date.now() + app.config.stepUpWindowMinutes * 60_000).toISOString();
        await tx.query('insert into step_up_sessions (id, user_id, verified_at, expires_at) values ($1, $2, now(), $3)', [id, userId, expiresAt]);

        await recordSecurityAudit(tx, {
          actorId: userId,
          action: 'twofa.step_up_verified',
          entity: 'step_up_sessions',
          entityId: id,
          after: { expiresAt },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return { stepUpToken: id, expiresAt };
      });
      reply.code(201);
      return result;
    }
  );
}
