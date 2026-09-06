/**
 * Errores de aplicación mapeados a respuestas `application/problem+json`
 * (RFC 7807) por el manejador de errores central (ver plugins/error-handler.ts).
 */
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public type: string,
    message: string,
    public detail?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class ValidationAppError extends AppError {
  constructor(detail: unknown) {
    super(422, 'https://atiende.example/errors/validation-failed', 'La solicitud no es válida', detail);
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Solicitud inválida', detail?: unknown) {
    super(400, 'https://atiende.example/errors/bad-request-input', message, detail);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'No autenticado') {
    super(401, 'https://atiende.example/errors/unauthorized', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'No autorizado para esta acción') {
    super(403, 'https://atiende.example/errors/forbidden', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado') {
    super(404, 'https://atiende.example/errors/not-found', message);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Conflicto con el estado actual', detail?: unknown) {
    super(409, 'https://atiende.example/errors/conflict', message, detail);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super(
      422,
      'https://atiende.example/errors/idempotency-key-conflict',
      'La misma Idempotency-Key se usó con un cuerpo de solicitud distinto'
    );
  }
}

export class TooManyRequestsError extends AppError {
  /**
   * R5-02 (docs/auditoria-2/api-ronda5.md): además del límite genérico de
   * `@fastify/rate-limit` (que ya expone `Retry-After` automáticamente),
   * el bloqueo progresivo por fallos de 2FA (contador en DB, ver
   * `lib/twofa-lockout.ts`) es una decisión de APLICACIÓN, no del plugin de
   * rate-limit -- así que este error lleva su propio `retryAfterSeconds`
   * para que `plugins/error-handler.ts` fije el mismo encabezado
   * `Retry-After` de forma consistente en ambos casos.
   */
  constructor(
    message = 'Demasiadas solicitudes',
    public retryAfterSeconds?: number
  ) {
    super(429, 'https://atiende.example/errors/too-many-requests', message);
  }
}
