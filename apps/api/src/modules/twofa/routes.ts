/**
 * REQ-044/064: enrolamiento y verificación TOTP (2FA/step-up) para
 * aprobaciones económicas sensibles. Endpoints de USUARIO (el enrolamiento
 * TOTP en sí es de la cuenta, válido para cualquier organización de la que
 * el usuario sea miembro) -- no llevan `app.requireOrg` como preHandler
 * (no exigen que el usuario sea MIEMBRO de esa organización, a diferencia
 * de una ruta normal de `apps/api`), pero R5-09
 * (docs/auditoria-2/api-ronda5-reverificacion.md) exige de todos modos un
 * `X-Org-Id` (UUID válido) y un `purpose` (enum cerrado,
 * `lib/step-up.ts#STEP_UP_PURPOSES`) para CREAR una sesión de step-up: la
 * sesión resultante queda atada a esa organización/acción concretas
 * (`requireStepUp` exige coincidencia exacta al consumirla desde la acción
 * real, que sí valida membresía vía su propio `app.requireOrg`).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { DbExecutor } from '@atiende/db';
import { recordSecurityAudit } from '../../lib/audit.js';
import { ConflictError, ForbiddenError, TooManyRequestsError } from '../../lib/errors.js';
import { checkTwofaLockout, recordTwofaFailure, resetTwofaFailures } from '../../lib/twofa-lockout.js';
import {
  encryptSecret,
  decryptSecret,
  generateTotpEnrollment,
  generateBackupCodes,
  hashBackupCode,
  verifyTotpCode,
  assertSixDigitCode,
  assertStepUpOrgId,
  assertStepUpPurpose,
  requireStepUp,
} from '../../lib/step-up.js';
import {
  enrollResponseSchema,
  totpCodeSchema,
  verifyEnrollmentResponseSchema,
  stepUpResponseSchema,
  stepUpStatusResponseSchema,
  disableResponseSchema,
  regenerateBackupCodesResponseSchema,
} from './schemas.js';

/** Un código de respaldo tiene forma "XXXX-XXXX"; cualquier otra cosa se intenta como TOTP de 6 dígitos. */
function looksLikeBackupCode(code: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code.trim());
}

/** R5-02: mensaje explícito de bloqueo progresivo, con los minutos restantes redondeados hacia arriba para no subestimar la espera real. */
function lockoutMessage(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return `Demasiados intentos fallidos de verificación en dos pasos para este usuario. Cuenta bloqueada temporalmente por ${minutes} minuto(s) -- inténtelo de nuevo más tarde.`;
}

/**
 * R5-02/R5-03: helper de transacción con el contexto RLS ya fijado (mismo
 * patrón repetido en cada handler de este módulo). CRÍTICO: cada llamada
 * abre su PROPIA transacción -- las escrituras de auditoría/contador de
 * fallos de una rama de RECHAZO se hacen en una transacción SEPARADA de la
 * que decide rechazar, para que el `throw` que produce el 403/429 al
 * cliente no haga ROLLBACK de esas mismas escrituras (si vivieran en la
 * misma transacción que el `throw`, Postgres revertiría el INSERT de
 * auditoría y el incremento del contador junto con todo lo demás -- el
 * mismo patrón que ya usa `auth.login_failed` en `modules/auth/routes.ts`,
 * en una transacción separada del resto del handler de `/auth/login`).
 */
async function withUserTx<T>(app: FastifyInstance, userId: string, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
    return fn(tx);
  });
}

interface FailureAuditParams {
  action: 'twofa.verification_failed' | 'twofa.step_up_denied';
  userId: string;
  reason: string;
  retryAfterSeconds?: number;
  requestId: string;
  correlationId?: string | null;
  /**
   * R5-10 (docs/auditoria-2/api-ronda5-reverificacion.md, MEDIA-BAJA): ip/
   * user-agent del cliente en el momento del fallo -- ver `auditContext`
   * abajo. Cierra la asimetría con `auth.login_failed` (API-13,
   * `modules/auth/routes.ts`), que ya los incluye.
   */
  ip: string;
  userAgent: string | null;
}

/** R5-10: mismo extractor que `auditContext` en `modules/auth/routes.ts` -- ip/user-agent de la request, NUNCA contraseñas/códigos/tokens. */
function auditContext(request: FastifyRequest): { ip: string; userAgent: string | null } {
  const ua = request.headers['user-agent'];
  return { ip: request.ip, userAgent: Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null) };
}

/** Incrementa el contador de fallos POR USUARIO (DB, con bloqueo progresivo) y audita el fallo, en su PROPIA transacción (ver `withUserTx`). Si el usuario ya estaba bloqueado, no vuelve a incrementar el contador (evita que reintentos durante el bloqueo alarguen el bloqueo indefinidamente). */
async function recordFailure(app: FastifyInstance, params: FailureAuditParams): Promise<void> {
  await withUserTx(app, params.userId, async (tx) => {
    await recordSecurityAudit(tx, {
      actorId: params.userId,
      action: params.action,
      entity: 'user_totp_secrets',
      entityId: params.userId,
      // R5-10: paridad con `auth.login_failed` -- ip/userAgent SIEMPRE
      // presentes en el `after` de un fallo de 2FA, junto con la razón.
      after: {
        reason: params.reason,
        ip: params.ip,
        userAgent: params.userAgent,
        ...(params.retryAfterSeconds !== undefined ? { retryAfterSeconds: params.retryAfterSeconds } : {}),
      },
      requestId: params.requestId,
      correlationId: params.correlationId,
    });
  });
}

export async function twofaRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/2fa/status',
    { preHandler: [app.authenticate], schema: { response: { 200: stepUpStatusResponseSchema } } },
    async (request) => {
      const userId = request.userId!;
      const { rows } = await withUserTx(app, userId, (tx) =>
        tx.query<{ verified_at: string | Date | null; enrolled_at: string | Date }>(
          'select verified_at, enrolled_at from user_totp_secrets where user_id = $1',
          [userId]
        )
      );
      if (rows.length === 0 || rows[0].verified_at === null) return { enrolled: false, enrolledAt: null };
      return { enrolled: true, enrolledAt: rows[0].enrolled_at };
    }
  );

  server.post(
    '/2fa/enroll',
    {
      preHandler: [app.authenticate],
      // R5-02: límite específico anti-fuerza-bruta (ver lib/rate-limit-settings.ts,
      // tier `twoFactor`) -- antes solo heredaba el límite `global` (300/min por IP).
      config: { rateLimit: { max: app.rateLimitSettings.twoFactor.max, timeWindow: app.rateLimitSettings.twoFactor.timeWindow } },
      schema: { response: { 201: enrollResponseSchema } },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const result = await withUserTx(app, userId, async (tx) => {
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
    {
      preHandler: [app.authenticate],
      // R5-02: límite específico anti-fuerza-bruta por IP (defensa en
      // profundidad ADICIONAL al contador por usuario en DB, ver
      // lib/twofa-lockout.ts, invocado más abajo).
      config: { rateLimit: { max: app.rateLimitSettings.twoFactor.max, timeWindow: app.rateLimitSettings.twoFactor.timeWindow } },
      schema: { body: totpCodeSchema, response: { 200: verifyEnrollmentResponseSchema } },
    },
    async (request) => {
      const userId = request.userId!;
      const code = assertSixDigitCode(request.body.code);
      const { ip, userAgent } = auditContext(request);

      // R5-02: contador de fallos POR USUARIO persistido en DB -- rotar de
      // IP no reinicia este presupuesto (a diferencia del límite de tasa
      // por IP de arriba). Se consulta ANTES de gastar cómputo verificando
      // el código, en su propia transacción de solo lectura.
      const lockout = await withUserTx(app, userId, (tx) => checkTwofaLockout(tx, userId));
      if (lockout.locked) {
        await recordFailure(app, { action: 'twofa.verification_failed', userId, reason: 'locked_out', retryAfterSeconds: lockout.retryAfterSeconds, requestId: request.id, correlationId: request.correlationId, ip, userAgent });
        throw new TooManyRequestsError(lockoutMessage(lockout.retryAfterSeconds), lockout.retryAfterSeconds);
      }

      const row = await withUserTx(app, userId, (tx) =>
        tx.query<{ secret_ciphertext: string; last_used_time_step: string | number | null }>(
          'select secret_ciphertext, last_used_time_step from user_totp_secrets where user_id = $1',
          [userId]
        )
      );
      if (row.rows.length === 0) {
        await recordFailure(app, { action: 'twofa.verification_failed', userId, reason: 'no_pending_enrollment', requestId: request.id, correlationId: request.correlationId, ip, userAgent });
        throw new ForbiddenError('No hay un enrolamiento de 2FA pendiente para este usuario. Llame primero a POST /auth/2fa/enroll.');
      }
      const secret = decryptSecret(row.rows[0].secret_ciphertext, app.config.totpEncryptionKey);
      const verification = await verifyTotpCode(secret, code);
      const lastUsed = row.rows[0].last_used_time_step === null ? null : Number(row.rows[0].last_used_time_step);
      if (!verification.valid || (lastUsed !== null && verification.timeStep <= lastUsed)) {
        // R5-03: fallos de verificación ahora quedan en audit_log (antes
        // solo se auditaban las ramas de ÉXITO) -- cierra la asimetría con
        // `auth.login_failed` (API-13/0051) y permite reconstruir un
        // intento de fuerza bruta en retrospectiva. R5-02: además
        // incrementa el contador de fallos por usuario (bloqueo progresivo).
        await withUserTx(app, userId, (tx) => recordTwofaFailure(tx, userId));
        await recordFailure(app, { action: 'twofa.verification_failed', userId, reason: 'invalid_code_or_replay', requestId: request.id, correlationId: request.correlationId, ip, userAgent });
        throw new ForbiddenError('Código TOTP inválido o ya utilizado (replay rechazado).');
      }

      // R5-09: orgId/purpose OBLIGATORIOS para crear la sesión de step-up
      // que esta confirmación emite de una vez (ver docstring del schema y
      // `lib/step-up.ts`) -- se valida DESPUÉS de confirmar que el código
      // es válido (nunca antes de eso: un cliente con código correcto pero
      // request mal formado sigue gastando el mismo "presupuesto" de
      // intento que cualquier otro fallo real, ni más ni menos).
      const orgId = assertStepUpOrgId(request.headers['x-org-id']);
      const purpose = assertStepUpPurpose(request.body.purpose);

      // Éxito: se persiste todo en UNA transacción final (si algo aquí
      // fallara, sí queremos que se revierta como conjunto atómico).
      return withUserTx(app, userId, async (tx) => {
        await tx.query('update user_totp_secrets set verified_at = now(), last_used_time_step = $1 where user_id = $2', [verification.timeStep, userId]);
        await resetTwofaFailures(tx, userId);

        // Confirmar el enrolamiento ya prueba posesión del TOTP -- se
        // emite de una vez una sesión de step-up (ver docstring del schema),
        // SIEMPRE atada a `orgId`/`purpose` (R5-09, ya no "genérica").
        const stepUpId = randomUUID();
        const expiresAt = new Date(Date.now() + app.config.stepUpWindowMinutes * 60_000).toISOString();
        await tx.query(
          'insert into step_up_sessions (id, user_id, verified_at, expires_at, org_id, purpose) values ($1, $2, now(), $3, $4, $5)',
          [stepUpId, userId, expiresAt, orgId, purpose]
        );

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
      // R5-02: mismo límite específico anti-fuerza-bruta que enroll/verify-enrollment.
      config: { rateLimit: { max: app.rateLimitSettings.twoFactor.max, timeWindow: app.rateLimitSettings.twoFactor.timeWindow } },
      schema: { body: totpCodeSchema, response: { 201: stepUpResponseSchema } },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const rawCode = request.body.code.trim();
      const { ip, userAgent } = auditContext(request);

      // R5-02: ver docstring equivalente en /2fa/verify-enrollment arriba.
      const lockout = await withUserTx(app, userId, (tx) => checkTwofaLockout(tx, userId));
      if (lockout.locked) {
        await recordFailure(app, { action: 'twofa.step_up_denied', userId, reason: 'locked_out', retryAfterSeconds: lockout.retryAfterSeconds, requestId: request.id, correlationId: request.correlationId, ip, userAgent });
        throw new TooManyRequestsError(lockoutMessage(lockout.retryAfterSeconds), lockout.retryAfterSeconds);
      }

      const totpRow = await withUserTx(app, userId, (tx) =>
        tx.query<{ secret_ciphertext: string; verified_at: string | Date | null; last_used_time_step: string | number | null }>(
          'select secret_ciphertext, verified_at, last_used_time_step from user_totp_secrets where user_id = $1',
          [userId]
        )
      );
      if (totpRow.rows.length === 0 || totpRow.rows[0].verified_at === null) {
        throw new ForbiddenError('Este usuario no tiene 2FA enrolado y verificado. Enrole primero con POST /auth/2fa/enroll y confirme con POST /auth/2fa/verify-enrollment.');
      }

      if (looksLikeBackupCode(rawCode)) {
        const codeHash = hashBackupCode(rawCode);
        const backupRow = await withUserTx(app, userId, (tx) =>
          tx.query<{ id: string }>('select id from user_backup_codes where user_id = $1 and code_hash = $2 and used_at is null', [userId, codeHash])
        );
        if (backupRow.rows.length === 0) {
          // R5-03: fallo de backup code (inválido o ya usado) también queda en audit_log.
          await withUserTx(app, userId, (tx) => recordTwofaFailure(tx, userId));
          await recordFailure(app, { action: 'twofa.step_up_denied', userId, reason: 'invalid_or_used_backup_code', requestId: request.id, correlationId: request.correlationId, ip, userAgent });
          throw new ForbiddenError('Código de respaldo inválido o ya utilizado.');
        }

        // R5-09: orgId/purpose OBLIGATORIOS -- validados solo tras confirmar
        // que el código de respaldo es válido (ver docstring equivalente en
        // /2fa/verify-enrollment arriba).
        const orgId = assertStepUpOrgId(request.headers['x-org-id']);
        const purpose = assertStepUpPurpose(request.body.purpose);

        return withUserTx(app, userId, async (tx) => {
          await tx.query('update user_backup_codes set used_at = now() where id = $1', [backupRow.rows[0].id]);
          const payload = await finalizeStepUp(app, tx, { userId, orgId, purpose, requestId: request.id, correlationId: request.correlationId });
          reply.code(201);
          return payload;
        });
      }

      const code = assertSixDigitCode(rawCode);
      const secret = decryptSecret(totpRow.rows[0].secret_ciphertext, app.config.totpEncryptionKey);
      const verification = await verifyTotpCode(secret, code);
      const lastUsed = totpRow.rows[0].last_used_time_step === null ? null : Number(totpRow.rows[0].last_used_time_step);
      if (!verification.valid || (lastUsed !== null && verification.timeStep <= lastUsed)) {
        // R5-03: código TOTP inválido/replay también queda en audit_log.
        await withUserTx(app, userId, (tx) => recordTwofaFailure(tx, userId));
        await recordFailure(app, { action: 'twofa.step_up_denied', userId, reason: 'invalid_code_or_replay', requestId: request.id, correlationId: request.correlationId, ip, userAgent });
        throw new ForbiddenError('Código TOTP inválido, o ya fue utilizado (replay rechazado).');
      }

      // R5-09: orgId/purpose OBLIGATORIOS -- validados solo tras confirmar
      // que el código TOTP es válido.
      const orgId = assertStepUpOrgId(request.headers['x-org-id']);
      const purpose = assertStepUpPurpose(request.body.purpose);

      const result = await withUserTx(app, userId, async (tx) => {
        await tx.query('update user_totp_secrets set last_used_time_step = $1 where user_id = $2', [verification.timeStep, userId]);
        return finalizeStepUp(app, tx, { userId, orgId, purpose, requestId: request.id, correlationId: request.correlationId });
      });
      reply.code(201);
      return result;
    }
  );

  // -------------------------------------------------------------------
  // E21 (docs/BACKLOG.md): desactivar 2FA de la cuenta propia y regenerar
  // los códigos de respaldo -- ambas exigen step-up (mismo `requireStepUp`
  // que el resto de `apps/api`, ver lib/step-up.ts). Como el resto de este
  // módulo, son endpoints de USUARIO (sin `app.requireOrg`): el `X-Org-Id`
  // que exige `requireStepUp` para emparejar la sesión es el mismo que se
  // usó para PEDIR el `stepUpToken` (`POST /2fa/step-up`/`verify-enrollment`
  // con `purpose: 'twofa.disable'`/`'twofa.backup_codes_regenerate'`), no
  // una organización "dueña" de la acción -- no existe tal cosa para un
  // secreto TOTP, que es de cuenta.
  // -------------------------------------------------------------------

  server.post(
    '/2fa/disable',
    { preHandler: [app.authenticate], schema: { response: { 200: disableResponseSchema } } },
    async (request) => {
      const userId = request.userId!;
      const orgId = assertStepUpOrgId(request.headers['x-org-id']);

      const result = await withUserTx(app, userId, async (tx) => {
        await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId, purpose: 'twofa.disable' });

        // Regla de negocio explícita (E21): nunca dejar la cuenta sin
        // NINGÚN método de acceso. Desactivar 2FA es seguro solo si a la
        // cuenta le queda al menos otro método propio para reautenticarse
        // -- contraseña (users.password_hash) o una identidad de Google
        // vinculada (user_identities, REQ-172). Se comprueba DESPUÉS de
        // `requireStepUp` (nunca antes: un rechazo por esta regla no debe
        // filtrar información a quien no probó posesión del 2FA) pero, si
        // se rechaza, el `stepUpToken` se consume igual (mismo patrón que
        // `company/routes.ts#rates/:id/approve` con una tarifa ya
        // decidida) -- se devuelve un marcador y se lanza el error FUERA
        // de la transacción, así el consumo del step-up sí se confirma.
        const userRow = await tx.query<{ password_hash: string | null }>('select password_hash from users where id = $1', [userId]);
        const hasPassword = (userRow.rows[0]?.password_hash ?? null) !== null;
        const identityRow = await tx.query<{ id: string }>('select id from user_identities where user_id = $1 limit 1', [userId]);
        const hasGoogleLinked = identityRow.rows.length > 0;
        if (!hasPassword && !hasGoogleLinked) {
          return { kind: 'no_other_access_method' as const };
        }

        await tx.query('delete from user_totp_secrets where user_id = $1', [userId]);
        await tx.query('delete from user_backup_codes where user_id = $1', [userId]);

        await recordSecurityAudit(tx, {
          actorId: userId,
          action: 'twofa.disabled',
          entity: 'user_totp_secrets',
          entityId: userId,
          after: { disabled: true },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return { kind: 'ok' as const };
      });

      if (result.kind === 'no_other_access_method') {
        throw new ConflictError(
          'No se puede desactivar la verificación en dos pasos: esta cuenta no tiene contraseña ni una cuenta de Google vinculada, y quedaría sin ningún método de acceso. Configure una contraseña o vincule una cuenta de Google antes de desactivar 2FA.'
        );
      }
      return { disabled: true as const };
    }
  );

  server.post(
    '/2fa/backup-codes/regenerate',
    {
      preHandler: [app.authenticate],
      // R5-02: mismo límite específico anti-fuerza-bruta que el resto del módulo.
      config: { rateLimit: { max: app.rateLimitSettings.twoFactor.max, timeWindow: app.rateLimitSettings.twoFactor.timeWindow } },
      schema: { response: { 201: regenerateBackupCodesResponseSchema } },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const orgId = assertStepUpOrgId(request.headers['x-org-id']);

      const backupCodes = await withUserTx(app, userId, async (tx) => {
        // requireStepUp ya exige un secreto TOTP enrolado y VERIFICADO
        // (verified_at not null) antes de siquiera mirar el encabezado
        // X-Step-Up -- si esto no lanza, el usuario sigue teniendo 2FA
        // activo, así que regenerar sus códigos de respaldo es seguro.
        await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId, purpose: 'twofa.backup_codes_regenerate' });

        // Se REEMPLAZAN por completo (mismo patrón que /2fa/enroll): los
        // códigos anteriores dejan de existir en la tabla, así que
        // cualquier intento posterior de usarlos (p.ej. como código de
        // /2fa/step-up) se rechaza de inmediato por no encontrar fila --
        // invalidación real, no solo "ocultos" en el cliente.
        await tx.query('delete from user_backup_codes where user_id = $1', [userId]);
        const codes = generateBackupCodes(10);
        for (const code of codes) {
          await tx.query('insert into user_backup_codes (id, user_id, code_hash) values ($1, $2, $3)', [randomUUID(), userId, hashBackupCode(code)]);
        }

        await recordSecurityAudit(tx, {
          actorId: userId,
          action: 'twofa.backup_codes_regenerated',
          entity: 'user_backup_codes',
          entityId: userId,
          after: { backupCodesIssued: codes.length },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return codes;
      });

      reply.code(201);
      return { backupCodes };
    }
  );
}

/** Común a ambas ramas (TOTP/backup code) de `/2fa/step-up` tras una verificación exitosa: reinicia el contador de fallos, emite la sesión de step-up (R5-09: SIEMPRE atada a org/purpose) y audita el éxito. */
async function finalizeStepUp(
  app: FastifyInstance,
  tx: DbExecutor,
  params: { userId: string; orgId: string; purpose: string; requestId: string; correlationId?: string | null }
): Promise<{ stepUpToken: string; expiresAt: string }> {
  await resetTwofaFailures(tx, params.userId);

  const id = randomUUID();
  const expiresAt = new Date(Date.now() + app.config.stepUpWindowMinutes * 60_000).toISOString();
  await tx.query(
    'insert into step_up_sessions (id, user_id, verified_at, expires_at, org_id, purpose) values ($1, $2, now(), $3, $4, $5)',
    [id, params.userId, expiresAt, params.orgId, params.purpose]
  );

  await recordSecurityAudit(tx, {
    actorId: params.userId,
    action: 'twofa.step_up_verified',
    entity: 'step_up_sessions',
    entityId: id,
    after: { expiresAt },
    requestId: params.requestId,
    correlationId: params.correlationId,
  });

  return { stepUpToken: id, expiresAt };
}
