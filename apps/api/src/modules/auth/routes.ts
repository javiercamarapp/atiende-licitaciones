import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../../lib/passwords.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '../../lib/jwt.js';
import { ConflictError, UnauthorizedError } from '../../lib/errors.js';
import { registerBodySchema, loginBodySchema, refreshBodySchema, authTokensSchema } from './schemas.js';

const UNIQUE_VIOLATION = '23505';

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
          throw new ConflictError('Ya existe una cuenta con ese email');
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

      const accessToken = await signAccessToken(app.config.jwtSecret, user.id);
      const refreshToken = await signRefreshToken(app.config.jwtSecret, user.id);
      return { accessToken, refreshToken };
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
      try {
        const payload = await verifyRefreshToken(app.config.jwtSecret, request.body.refreshToken);
        userId = payload.sub;
      } catch {
        throw new UnauthorizedError('Refresh token inválido o expirado');
      }

      const accessToken = await signAccessToken(app.config.jwtSecret, userId);
      const refreshToken = await signRefreshToken(app.config.jwtSecret, userId);
      return { accessToken, refreshToken };
    }
  );
}
