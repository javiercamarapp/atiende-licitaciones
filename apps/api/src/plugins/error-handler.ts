import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError, TooManyRequestsError } from '../lib/errors.js';
import { recordAccessDenied } from '../lib/audit.js';

interface ProblemJson {
  type: string;
  title: string;
  status: number;
  detail?: unknown;
  requestId: string;
  correlationId?: string;
}

async function errorHandlerImpl(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(async (err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;
    const correlationId = request.correlationId;

    if (err instanceof AppError) {
      // R5-02: bloqueo progresivo por fallos de 2FA -- mismo encabezado
      // `Retry-After` que ya expone `@fastify/rate-limit` (ver app.ts),
      // pero fijado a mano porque este 429 lo decide la aplicación (contador
      // en DB), no el plugin.
      if (err instanceof TooManyRequestsError && typeof err.retryAfterSeconds === 'number') {
        reply.header('retry-after', String(Math.max(0, Math.ceil(err.retryAfterSeconds))));
      }

      // Patrón Likida/atiende.ai #6: complemento del mapa ruta/rol
      // (`requireOrgRole`/`APPROVER_ROLES`/`MEMBERSHIP_ADMIN_ROLES`,
      // `app.requireSuperadmin`) -- CADA 403 de `AppError` queda en
      // `audit_log` (acción `access.denied`), no solo en el log efímero
      // de la request. Centralizado aquí (en vez de en cada ruta que
      // lanza `ForbiddenError`) para no dejar ningún punto sin cubrir.
      // Requiere un actor autenticado: los 403 pre-autenticación (p.ej.
      // `EmailNotVerifiedError` durante login, o el rechazo de un Google
      // login con email no verificado) todavía no tienen `request.userId`
      // -- no hay a quién atribuirle el intento, así que se omiten (ese
      // caso ya queda cubierto por los eventos de `auth.*` existentes).
      if (err.statusCode === 403 && request.userId) {
        // `request.orgId` solo queda fijado cuando `app.requireOrg` SÍ
        // resolvió membresía. Cuando deniega precisamente por falta de
        // membresía, `request.orgId` sigue `undefined` -- se usa el
        // `X-Org-Id` de la request como mejor esfuerzo (sin validar: si
        // no es un UUID, `recordAccessDenied` lo traga y solo deja un
        // warning en el logger, nunca rompe la respuesta 403 real).
        const requestedOrgId = request.headers['x-org-id'];
        const orgId = request.orgId ?? (typeof requestedOrgId === 'string' ? requestedOrgId : null);
        await recordAccessDenied(
          app.db,
          {
            actorId: request.userId,
            orgId,
            entity: request.url,
            requestId,
            correlationId,
            detail: { method: request.method, statusCode: err.statusCode, message: err.message },
          },
          (auditErr) =>
            request.log.warn(
              { err: auditErr, requestId },
              'no se pudo registrar en audit_log el intento de acceso denegado (la respuesta 403 al cliente no se ve afectada)'
            )
        );
      }

      const problem: ProblemJson = {
        type: err.type,
        title: err.message,
        status: err.statusCode,
        detail: err.detail,
        requestId,
        correlationId,
      };
      reply.code(err.statusCode).type('application/problem+json').send(problem);
      return;
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      const problem: ProblemJson = {
        type: 'https://atiende.example/errors/validation-failed',
        title: 'La solicitud no es válida',
        status: 422,
        detail: err.validation,
        requestId,
        correlationId,
      };
      reply.code(422).type('application/problem+json').send(problem);
      return;
    }

    const fastifyErr = err as { statusCode?: number; message?: string };
    const statusCode = fastifyErr.statusCode && fastifyErr.statusCode >= 400 ? fastifyErr.statusCode : 500;
    const isServerError = statusCode >= 500;
    const isProd = app.config.nodeEnv === 'production';

    if (isServerError) {
      request.log.error({ err, requestId }, 'unhandled error');
    }

    const problem: ProblemJson = {
      type: isServerError
        ? 'https://atiende.example/errors/internal-server-error'
        : 'https://atiende.example/errors/bad-request',
      title: isServerError && isProd ? 'Error interno del servidor' : fastifyErr.message || 'Error',
      status: statusCode,
      requestId,
    };
    reply.code(statusCode).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    const problem: ProblemJson = {
      type: 'https://atiende.example/errors/not-found',
      title: `Ruta no encontrada: ${request.method} ${request.url}`,
      status: 404,
      requestId: request.id,
      correlationId: request.correlationId,
    };
    reply.code(404).type('application/problem+json').send(problem);
  });
}

export const errorHandlerPlugin = fp(errorHandlerImpl, { name: 'error-handler-plugin' });
