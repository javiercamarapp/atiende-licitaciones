import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../lib/passwords.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/jwt.js';
import { UnauthorizedError } from '../../lib/errors.js';
import { registerBodySchema, loginBodySchema, refreshBodySchema, logoutBodySchema, authTokensSchema } from './schemas.js';

const UNIQUE_VIOLATION = '23505';
const REFRESH_TTL_DAYS = 30;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function issueTokenPair(
  app: FastifyInstance,
  userId: string
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = await signAccessToken(app.config.jwtSecret, userId);
  const { token: refreshToken, jti } = await signRefreshToken(app.config.jwtSecret, userId);
  await app.db.transaction(async (tx) => {
    await tx.query('set local role app_role');
    // DB-08 (docs/auditoria-1/db-api-reverificacion.md, CRÍTICA):
    // `app.create_refresh_token` ahora exige que `app.current_user_id()` ya
    // esté fijado y coincida con el `user_id` del token -- nunca confía en
    // el parámetro por sí solo (mismo patrón que 0019 aplicó a DB-01). Se
    // fija aquí al id YA verificado por el caller de `issueTokenPair`
    // (login: contraseña recién validada; refresh: `sub` de un JWT firmado
    // por el propio servidor) -- nunca a partir de un valor de entrada del
    // cliente sin verificar.
    await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
    await tx.query(`select app.create_refresh_token($1, $2, $3, now() + interval '${REFRESH_TTL_DAYS} days')`, [
      randomUUID(),
      userId,
      hashToken(jti),
    ]);
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

      reply.code(201);
      return { id, email };
    }
  );

  server.post(
    '/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        body: loginBodySchema,
        response: { 200: authTokensSchema },
      },
    },
    async (request) => {
      const { email, password } = request.body;

      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        return tx.query<{ id: string; password_hash: string; is_active: boolean }>(
          'select * from app.find_user_by_email($1)',
          [email]
        );
      });

      const user = rows[0];
      if (!user || !user.is_active) {
        throw new UnauthorizedError('Credenciales inválidas');
      }
      const valid = await verifyPassword(password, user.password_hash);
      if (!valid) {
        throw new UnauthorizedError('Credenciales inválidas');
      }

      return issueTokenPair(app, user.id);
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

      // `app.rotate_refresh_token` NUNCA lanza excepción en el camino de
      // fallo (ver 0043_fix_api01_atomic_refresh_rotation.sql): si lo
      // hiciera, un `raise exception` revertiría TODA la transacción,
      // incluida la revocación de familia por reuso hecha dentro de la
      // misma sentencia -- por eso el resultado se distingue por número de
      // filas devueltas (0 = inválido/expirado/reusado), no por catch.
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        return tx.query<{ user_id: string }>(
          `select * from app.rotate_refresh_token($1, $2, $3, now() + interval '${REFRESH_TTL_DAYS} days')`,
          [hashToken(jti), randomUUID(), hashToken(newJti)]
        );
      });
      if (rows.length === 0) {
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
        });
      } catch {
        // Logout es idempotente y nunca revela si el token era válido: un
        // token ya inválido/expirado/ajeno simplemente no revoca nada.
      }
      return reply.code(204).send();
    }
  );
}
