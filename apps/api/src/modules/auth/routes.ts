import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../lib/passwords.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/jwt.js';
import { UnauthorizedError, EmailNotVerifiedError } from '../../lib/errors.js';
import { recordAuthAudit, type AuthAuditAction } from '../../lib/audit.js';
import { registerBodySchema, loginBodySchema, refreshBodySchema, logoutBodySchema, authTokensSchema } from './schemas.js';
import { sendEmailVerification } from '../../lib/mail/triggers.js';
import { fireAndForgetMail } from '../../lib/mail/pending.js';
import type { FastifyRequest } from 'fastify';

const UNIQUE_VIOLATION = '23505';
const REFRESH_TTL_DAYS = 30;

// API-03 (docs/auditoria-1/db-api-reverificacion.md, PARCIAL -> cerrado
// aquí): `/auth/login` solo ejecutaba `verifyPassword` (scrypt, costoso)
// cuando el email SÍ existía -- un email inexistente devolvía 401 casi
// instantáneamente (sin scrypt), un email existente con password
// incorrecta tardaba ~27ms (scrypt real). La reverificación midió un
// oráculo de timing de 24x (0% overlap en 15/15 muestras aisladas),
// suficiente para enumerar cuentas por email sin ninguna otra señal. Este
// hash ficticio, con formato válido (`scrypt:<salt>:<hash>`, mismo
// KEY_LENGTH=64 que `hashPassword`), fuerza a que `verifyPassword` (y por
// tanto el costo real de scrypt) se ejecute SIEMPRE, exista o no la cuenta
// -- nunca compara nada contra un hash real, timingSafeEqual simplemente
// fallará porque el password jamás coincidirá con este salt/hash fijo.
const DUMMY_PASSWORD_HASH = `scrypt:${'00'.repeat(16)}:${'00'.repeat(64)}`;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** API-13: extrae ip/user-agent de la petición para auditoría -- NUNCA contraseñas ni tokens. */
export function auditContext(request: FastifyRequest): { ip: string; userAgent: string | null } {
  const ua = request.headers['user-agent'];
  return { ip: request.ip, userAgent: Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null) };
}

export interface IssueTokenPairAudit {
  ip: string;
  userAgent: string | null;
  requestId: string;
  /**
   * REQ-175/REQ-177: acción de `audit_log` a registrar para la emisión de
   * este par de tokens -- por defecto `'auth.login_succeeded'`
   * (comportamiento histórico de `/auth/login`, sin cambios). El login con
   * Google (`modules/auth/google/routes.ts`) reutiliza esta MISMA función
   * (nunca una reimplementación paralela) pasando `'auth.google_login'`,
   * para garantizar por construcción que ambos flujos comparten formato,
   * duración y mecanismo de rotación de sesión (REQ-175).
   */
  action?: AuthAuditAction;
  /** Metadatos adicionales a fusionar en el `after` del evento de auditoría -- NUNCA contraseñas/tokens (p.ej. `{ provider: 'google' }`). */
  extra?: Record<string, unknown>;
}

/**
 * Emite un par access/refresh token nuevo y dos efectos con el mismo
 * user_id YA VERIFICADO por el caller (password recién validada, `sub` de
 * un JWT firmado por el propio servidor, o identidad de Google recién
 * vinculada/creada -- nunca un valor de entrada sin verificar): persiste el
 * refresh token (`app.create_refresh_token`) y deja rastro en `audit_log`
 * (API-13). Exportada para que `modules/auth/google/routes.ts` reutilice
 * exactamente este mismo camino (REQ-175: mismo esquema y política de
 * expiración que el login por email+contraseña).
 */
export async function issueTokenPair(
  app: FastifyInstance,
  userId: string,
  audit: IssueTokenPairAudit
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = await signAccessToken(app.config.jwtSecret, userId);
  const { token: refreshToken, jti } = await signRefreshToken(app.config.jwtSecret, userId);
  const action: AuthAuditAction = audit.action ?? 'auth.login_succeeded';
  await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    // DB-08 (docs/auditoria-1/db-api-reverificacion.md, CRÍTICA):
    // `app.create_refresh_token` ahora exige que `app.current_user_id()` ya
    // esté fijado y coincida con el `user_id` del token -- nunca confía en
    // el parámetro por sí solo (mismo patrón que 0019 aplicó a DB-01). Se
    // fija aquí al id YA verificado por el caller de `issueTokenPair`
    // (login: contraseña recién validada; refresh: `sub` de un JWT firmado
    // por el propio servidor; Google: identidad vinculada/creada dentro de
    // la MISMA transacción de `modules/auth/google/routes.ts`) -- nunca a
    // partir de un valor de entrada del cliente sin verificar.
    await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
    await tx.query(`select app.create_refresh_token($1, $2, $3, now() + interval '${REFRESH_TTL_DAYS} days')`, [
      randomUUID(),
      userId,
      hashToken(jti),
    ]);
    // API-13: login exitoso ahora deja rastro en audit_log (actor, ip,
    // user-agent, request_id -- nunca contraseña ni token).
    await recordAuthAudit(tx, { actorId: userId, action, after: { ip: audit.ip, userAgent: audit.userAgent, ...audit.extra }, requestId: audit.requestId });
  });
  return { accessToken, refreshToken };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/register',
    {
      schema: {
        body: registerBodySchema,
        response: { 201: z.object({ id: z.string().uuid(), email: z.string() }) },
      },
    },
    async (request, reply) => {
      const { email, password, fullName } = request.body;
      const id = randomUUID();
      const passwordHash = await hashPassword(password);

      try {
        // Registro es una acción anónima: sin RETURNING (ver nota de diseño
        // en packages/db/test/org-bootstrap.test.ts) porque el actor todavía
        // no tiene contexto de usuario para pasar la política SELECT.
        await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query('insert into users (id, email, password_hash, full_name) values ($1, $2, $3, $4)', [
            id,
            email,
            passwordHash,
            fullName ?? null,
          ]);
        });
      } catch (err) {
        const pgErr = err as { code?: string };
        if (pgErr.code === UNIQUE_VIOLATION) {
          // API-03 (docs/auditoria-1/db-api.md): NUNCA confirmar por status
          // code (o mensaje) que un email ya está registrado -- eso permite
          // enumerar cuentas. Se responde el mismo 201 genérico que un
          // registro nuevo exitoso, sin crear una fila duplicada ni tocar
          // la cuenta real existente (la contraseña original nunca se
          // sobrescribe). El `id` devuelto aquí es intencionalmente el
          // recién generado (no persistido, no el de la cuenta real): no
          // filtra el id verdadero del usuario existente.
          reply.code(201);
          return { id, email };
        }
        throw err;
      }

      // REQ-181..195: correo de verificación -- SIN esperar (`.catch`, no
      // `await`) antes de responder. Dos motivos: (1) API-03 (timing de
      // registro, ver comentario de la rama de email duplicado arriba) --
      // si se esperara aquí, un registro NUEVO (manda correo real) tardaría
      // medible/consistentemente más que uno duplicado (nunca llega a este
      // punto), reabriendo el mismo oráculo de enumeración que ese
      // endpoint ya cerró; (2) un fallo transitorio del proveedor de
      // correo (o el propio MailService agotando sus reintentos) nunca
      // debe convertir un registro por lo demás exitoso en un 500 --
      // `sendTransactionalMail` ya deja un rastro reintentable en `jobs`
      // (`mail_retry`) si termina `dead`, así que no hace falta que esta
      // ruta se entere del resultado para que el correo termine llegando.
      fireAndForgetMail(app, 'email-verification', () => sendEmailVerification(app, { id, email, fullName: fullName ?? null }));

      reply.code(201);
      return { id, email };
    }
  );

  server.post(
    '/login',
    {
      // Ronda 4: el límite concreto viene de `app.rateLimitSettings.auth`
      // (ver `lib/rate-limit-settings.ts`) -- 5/min salvo
      // `RATE_LIMIT_PROFILE=e2e`, nunca activo por defecto (ver config.ts).
      config: { rateLimit: { max: app.rateLimitSettings.auth.max, timeWindow: app.rateLimitSettings.auth.timeWindow } },
      schema: {
        body: loginBodySchema,
        response: { 200: authTokensSchema },
      },
    },
    async (request) => {
      const { email, password } = request.body;

      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        return tx.query<{ id: string; password_hash: string | null; is_active: boolean; email_verified_at: string | null }>(
          'select * from app.find_user_by_email($1)',
          [email]
        );
      });

      const user = rows[0];
      // REQ-172..180 (0071_req172_google_oidc.sql): una cuenta creada
      // EXCLUSIVAMENTE vía Google (sin contraseña propia,
      // `password_hash is null`) debe rechazar SIEMPRE el login por
      // email+contraseña -- se trata igual que "cuenta inexistente" para
      // efectos del oráculo de timing (API-03, ver comentario abajo): nunca
      // se compara contra `null`, siempre contra ALGÚN hash con formato
      // válido (el real, o el ficticio).
      const isUsable = Boolean(user && user.is_active && user.password_hash);
      // Siempre se invoca verifyPassword (scrypt real) con ALGÚN hash, sea
      // el real del usuario o el ficticio -- nunca se decide antes si vale
      // la pena "gastar" el cómputo según si la cuenta existe. Esa decisión
      // condicional es precisamente lo que hacía observable por timing si
      // el email existía o no.
      const valid = await verifyPassword(password, isUsable ? user!.password_hash! : DUMMY_PASSWORD_HASH);
      if (!isUsable || !valid) {
        // API-13: login fallido queda en audit_log (actor conocido si el
        // email existe, aunque la contraseña sea incorrecta; null si el
        // email ni siquiera existe) -- nunca se registra la contraseña
        // enviada. Best-effort: un fallo al auditar nunca debe convertir un
        // 401 legítimo en un 500 ni filtrar información adicional.
        try {
          await app.db.transaction(async (tx) => {
            await tx.query('set local role app_role');
            await recordAuthAudit(tx, {
              actorId: user?.id ?? null,
              action: 'auth.login_failed',
              after: { email, ...auditContext(request) },
              requestId: request.id,
            });
          });
        } catch {
          // ver nota arriba: nunca se deja que un fallo de auditoría oculte el 401 real.
        }
        throw new UnauthorizedError('Credenciales inválidas');
      }

      // REQ-181..195: compuerta de verificación de correo. Va DESPUÉS de
      // validar la contraseña a propósito: llegar aquí ya prueba que quien
      // pide es el dueño de la cuenta, así que decirle "confirma tu correo"
      // no filtra nada a un tercero (invertir el orden SÍ convertiría este
      // 403 en un oráculo de existencia de cuenta, sin necesidad de acertar
      // la contraseña). `config.requireEmailVerification` la deja apagable
      // para un despliegue todavía sin proveedor de correo real -- ver
      // config.ts.
      if (app.config.requireEmailVerification && user!.email_verified_at === null) {
        try {
          await app.db.transaction(async (tx) => {
            await tx.query('set local role app_role');
            await recordAuthAudit(tx, {
              actorId: user!.id,
              action: 'auth.login_failed',
              after: { email, motivo: 'email_no_verificado', ...auditContext(request) },
              requestId: request.id,
            });
          });
        } catch {
          // ver nota de la rama de credenciales inválidas: la auditoría nunca oculta la respuesta real.
        }
        throw new EmailNotVerifiedError();
      }

      return issueTokenPair(app, user!.id, { ...auditContext(request), requestId: request.id });
    }
  );

  server.post(
    '/refresh',
    {
      schema: {
        body: refreshBodySchema,
        response: { 200: authTokensSchema },
      },
    },
    async (request) => {
      let userId: string;
      let jti: string;
      try {
        const payload = await verifyRefreshToken(app.config.jwtSecret, request.body.refreshToken);
        userId = payload.sub;
        jti = payload.jti;
      } catch {
        throw new UnauthorizedError('Refresh token inválido o expirado');
      }

      // API-01/API-09 (docs/auditoria-1/db-api-reverificacion.md): la
      // rotación anterior hacía SELECT (find_refresh_token) y UPDATE
      // (revoke_refresh_token) en transacciones SEPARADAS, sin comprobar el
      // resultado del UPDATE antes de emitir tokens nuevos -- una ventana
      // TOCTOU real bajo el pool de conexiones de producción: dos
      // `/auth/refresh` concurrentes con el MISMO token podían leer "no
      // revocado" ambos y ambos terminar emitiendo tokens hijos válidos.
      // `app.rotate_refresh_token` hace check-y-mutación ATÓMICOS en una
      // sola sentencia (`UPDATE ... WHERE revoked_at IS NULL RETURNING`,
      // ver 0043_fix_api01_atomic_refresh_rotation.sql): el bloqueo de fila
      // de Postgres garantiza que como mucho UNA petición concurrente gane
      // la rotación; la otra ve la fila ya revocada y cae en la rama de
      // "reuso detectado", que además revoca preventivamente el resto de
      // sesiones activas del usuario (protección de familia completa, no
      // solo del token reusado).
      const newAccessToken = await signAccessToken(app.config.jwtSecret, userId);
      const { token: newRefreshToken, jti: newJti } = await signRefreshToken(app.config.jwtSecret, userId);
      const audit = auditContext(request);

      // `app.rotate_refresh_token` NUNCA lanza excepción en el camino de
      // fallo (ver 0043_fix_api01_atomic_refresh_rotation.sql): si lo
      // hiciera, un `raise exception` revertiría TODA la transacción,
      // incluida la revocación de familia por reuso hecha dentro de la
      // misma sentencia -- por eso el resultado se distingue por número de
      // filas devueltas (0 = inválido/expirado/reusado), no por catch.
      const ok = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        const rotated = await tx.query<{ user_id: string }>(
          `select * from app.rotate_refresh_token($1, $2, $3, now() + interval '${REFRESH_TTL_DAYS} days')`,
          [hashToken(jti), randomUUID(), hashToken(newJti)]
        );
        if (rotated.rows.length > 0) {
          // API-14 (docs/auditoria-2/api-expediente-reverificacion.md):
          // `app.record_auth_event` (0054) ahora exige que
          // `app.current_user_id()` ya esté fijado y coincida con el
          // `actor_id` declarado para cualquier acción que no sea
          // `auth.login_failed` -- se fija aquí al `user_id` YA verificado
          // por `app.rotate_refresh_token` (nunca a partir de un valor de
          // entrada del cliente sin verificar).
          await tx.query("select set_config('app.current_user_id', $1, true)", [rotated.rows[0].user_id]);
          // API-13: rotación/refresh exitosos quedan en audit_log.
          await recordAuthAudit(tx, { actorId: rotated.rows[0].user_id, action: 'auth.refresh_succeeded', after: audit, requestId: request.id });
          return true;
        }
        // API-13 (docs/auditoria-1/db-api-seguridad-reverificacion.md):
        // 0 filas puede significar token inexistente, expirado, O REUSADO
        // (ya revocado -- caso en el que `rotate_refresh_token` YA revocó
        // preventivamente toda la familia de sesiones activas dentro de la
        // MISMA sentencia/transacción, ver 0043). Solo el caso de REUSO
        // real tiene valor de seguridad para auditar -- se distingue
        // consultando `app.find_refresh_token` (mismo hash del token viejo
        // presentado): `revoked_at is not null` es exactamente la señal
        // que usa `rotate_refresh_token` para decidir la revocación de
        // familia.
        return tx.query<{ user_id: string; revoked_at: string | null }>('select * from app.find_refresh_token($1)', [hashToken(jti)]).then(async (found) => {
          if (found.rows.length > 0 && found.rows[0].revoked_at !== null) {
            // API-14: mismo cierre que `refresh_succeeded` arriba -- fija
            // el actor con el `user_id` YA verificado por
            // `app.find_refresh_token` antes de auditar.
            await tx.query("select set_config('app.current_user_id', $1, true)", [found.rows[0].user_id]);
            await recordAuthAudit(tx, { actorId: found.rows[0].user_id, action: 'auth.refresh_reuse_detected', after: audit, requestId: request.id });
          }
          return false;
        });
      });
      if (!ok) {
        throw new UnauthorizedError('Refresh token inválido, expirado o revocado');
      }

      return { accessToken: newAccessToken, refreshToken: newRefreshToken };
    }
  );

  server.post(
    '/logout',
    { schema: { body: logoutBodySchema } },
    async (request, reply) => {
      try {
        const payload = await verifyRefreshToken(app.config.jwtSecret, request.body.refreshToken);
        await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query('select app.revoke_refresh_token($1)', [hashToken(payload.jti)]);
          // API-14: fija el actor con el `sub` de un JWT ya verificado
          // (`verifyRefreshToken`, firmado por el propio servidor) antes de
          // auditar -- nunca a partir de un valor de entrada sin verificar.
          await tx.query("select set_config('app.current_user_id', $1, true)", [payload.sub]);
          // API-13: logout deja rastro en audit_log (solo cuando el token
          // era válido -- un token ya inválido/ajeno no revoca nada, así
          // que tampoco genera un evento de "logout" real).
          await recordAuthAudit(tx, { actorId: payload.sub, action: 'auth.logout', after: auditContext(request), requestId: request.id });
        });
      } catch {
        // Logout es idempotente y nunca revela si el token era válido: un
        // token ya inválido/expirado/ajeno simplemente no revoca nada (ni
        // se audita, para no filtrar información).
      }
      return reply.code(204).send();
    }
  );
}
