import { z } from 'zod';

export const googleStartResponseSchema = z.object({
  authorizationUrl: z.string().url(),
});

export const googleCallbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1),
  /** Google puede volver con `error=access_denied` (usuario canceló el consentimiento) en vez de `code`. */
  error: z.string().optional(),
});

export const googleVerify2faBodySchema = z.object({
  pendingToken: z.string().min(1),
  /** Código TOTP de 6 dígitos, o código de respaldo "XXXX-XXXX". */
  code: z.string().min(1),
});

/**
 * Respuesta única para `GET /auth/google/callback` y
 * `POST /auth/google/verify-2fa` -- un objeto plano con campos opcionales
 * (no un `z.union`/`discriminatedUnion`: sin precedente en este código base
 * para `response`, y `fastify-type-provider-zod`/`@fastify/swagger` no
 * tienen cobertura de prueba propia con uniones aquí) en vez de tres formas
 * distintas:
 *  - `status: 'ok'` | `'sin_acceso'` (REQ-172/REQ-174/REQ-180): sesión
 *    completa, `accessToken`/`refreshToken` presentes (REQ-175: mismo
 *    esquema que `authTokensSchema` de `modules/auth/schemas.ts`).
 *    `sin_acceso` señala al frontend que el usuario no pertenece a ninguna
 *    organización todavía (mismo estado que ya es alcanzable hoy vía
 *    registro por email+contraseña sin crear/unirse a una organización --
 *    esto NO es una concesión de autorización nueva: cualquier endpoint de
 *    organización sigue exigiendo membresía real vía `app.requireOrg`).
 *  - `status: 'requires_2fa'` (REQ-176): la cuenta ya tiene 2FA
 *    enrolado/verificado -- `pendingToken` (nunca un access token real,
 *    ver `pending-2fa.ts`) debe canjearse en `POST /auth/google/verify-2fa`
 *    junto con un código TOTP/backup válido.
 */
export const googleAuthResultSchema = z.object({
  status: z.enum(['ok', 'sin_acceso', 'requires_2fa']),
  accessToken: z.string().optional(),
  refreshToken: z.string().optional(),
  pendingToken: z.string().optional(),
});
