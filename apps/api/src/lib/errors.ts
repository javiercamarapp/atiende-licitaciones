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
  constructor(message = 'Conflicto con el estado actual') {
    super(409, 'https://atiende.example/errors/conflict', message);
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
  constructor(message = 'Demasiadas solicitudes') {
    super(429, 'https://atiende.example/errors/too-many-requests', message);
  }
}
