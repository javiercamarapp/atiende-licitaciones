import type { FastifyRequest } from 'fastify';
import type { OrgRole, OicRole } from '@atiende/db';
import { ForbiddenError } from './errors.js';

/**
 * Verificación de rol EN LA APLICACIÓN, además de (nunca en sustitución de)
 * RLS en `packages/db`. RLS es la última línea de defensa (incluso si esta
 * verificación tuviera un bug); esta capa da errores 403 explícitos y
 * mensajes claros en vez de dejar que una escritura silenciosamente afecte
 * 0 filas por RLS.
 */
export function requireOrgRole(request: FastifyRequest, allowed: OrgRole[], message?: string): void {
  const role = request.orgRole;
  if (!role || !allowed.includes(role)) {
    throw new ForbiddenError(message ?? `Esta acción requiere uno de estos roles: ${allowed.join(', ')}`);
  }
}

/** REQ-060: paralelo de `requireOrgRole`, pero para `request.oicRole` (lado comprador/OIC). */
export function requireOicRole(request: FastifyRequest, allowed: OicRole[], message?: string): void {
  const role = request.oicRole;
  if (!role || !allowed.includes(role)) {
    throw new ForbiddenError(message ?? `Esta acción requiere uno de estos roles OIC: ${allowed.join(', ')}`);
  }
}

/** Verifica `request.isSuperadmin` (decorado por `app.requireSuperadmin`). */
export function requireSuperadminFlag(request: FastifyRequest): void {
  if (!request.isSuperadmin) {
    throw new ForbiddenError('Esta acción requiere privilegios de superadmin de plataforma');
  }
}
