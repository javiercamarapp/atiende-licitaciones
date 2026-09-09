import { z } from 'zod';
import { isoTimestamp } from '../../lib/schema-helpers.js';

export const registerBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
  fullName: z.string().min(1).optional(),
});
export type RegisterBody = z.infer<typeof registerBodySchema>;

export const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginBody = z.infer<typeof loginBodySchema>;

export const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshBody = z.infer<typeof refreshBodySchema>;

export const logoutBodySchema = z.object({
  refreshToken: z.string().min(1),
});
export type LogoutBody = z.infer<typeof logoutBodySchema>;

export const authTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});

export const userPublicSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  fullName: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// E21 (docs/BACKLOG.md): sesiones activas (refresh token families) y cambio
// de contraseña propia con step-up.
// ---------------------------------------------------------------------------

export const sessionSchema = z.object({
  id: z.string().uuid(),
  // Mismo bug documentado en `lib/schema-helpers.ts`: las columnas
  // timestamptz vuelven del driver (pg/PGlite) como instancias de Date,
  // nunca string ISO -- un z.string() estricto aquí rompería la respuesta
  // con 500 en runtime real (nunca visible con mocks/objetos planos en
  // memoria, por eso ninguna prueba unitaria "ingenua" lo detectaría).
  createdAt: isoTimestamp,
  expiresAt: isoTimestamp,
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
});
export const sessionsListSchema = z.object({ sessions: z.array(sessionSchema) });

export const sessionIdParamsSchema = z.object({ id: z.string().uuid() });

export const revokeSessionResponseSchema = z.object({ revoked: z.literal(true) });

export const revokeOtherSessionsBodySchema = z.object({
  /** Refresh token que la sesión LLAMANDO a este endpoint está usando ahora mismo -- ver docstring de `app.revoke_other_refresh_tokens`. */
  refreshToken: z.string().min(1),
});
export const revokeOtherSessionsResponseSchema = z.object({ revokedCount: z.number().int().nonnegative() });

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres'),
});
export const changePasswordResponseSchema = z.object({ changed: z.literal(true) });
