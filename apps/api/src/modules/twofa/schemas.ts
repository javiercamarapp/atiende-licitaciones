import { z } from 'zod';
import { isoTimestamp } from '../../lib/schema-helpers.js';

export const enrollResponseSchema = z.object({
  secretBase32: z.string(),
  otpauthUrl: z.string(),
  /** Se muestran UNA sola vez, en claro, al enrolar/re-enrolar -- después solo se guarda su hash. */
  backupCodes: z.array(z.string()),
});

export const totpCodeSchema = z.object({
  code: z.string().min(4).max(16),
  /**
   * R5-09 (docs/auditoria-2/api-ronda5-reverificacion.md, BAJA-MEDIA):
   * OBLIGATORIO en la práctica (junto con el encabezado `X-Org-Id`) para
   * atar el `stepUpToken` resultante a una organización/acción concreta
   * (p.ej. "company.rate_approval", "expediente.approval", ver
   * `lib/step-up.ts#STEP_UP_PURPOSES`). Se mantiene `.optional()` aquí a
   * propósito -- la validación real de "obligatorio + enum cerrado"
   * ocurre en el handler vía `assertStepUpPurpose` (lib/step-up.ts), que
   * responde 400 explícito (no el 422 genérico de un `schema.body`
   * fallido) cuando falta o no es uno de los valores permitidos. Antes de
   * esta ronda (R5-05, 0061) era verdaderamente opcional y una sesión sin
   * `purpose` quedaba "genérica" -- ningún cliente real lo declaraba
   * nunca, así que ese alcance nunca se aplicaba en la práctica (ver
   * R5-09); ahora toda sesión nueva exige `purpose`, sin excepción.
   */
  purpose: z.string().min(1).max(64).optional(),
});

export const verifyEnrollmentResponseSchema = z.object({
  enrolled: z.literal(true),
  /**
   * Confirmar el enrolamiento requiere probar posesión del TOTP igual que
   * un step-up normal -- se emite una sesión de step-up inmediata junto
   * con la confirmación, para no obligar a un segundo código (que
   * colisionaría con el mismo "time step" de 30s recién usado).
   */
  stepUpToken: z.string().uuid(),
  expiresAt: isoTimestamp,
});

export const stepUpResponseSchema = z.object({
  stepUpToken: z.string().uuid(),
  expiresAt: isoTimestamp,
});

export const stepUpStatusResponseSchema = z.object({
  enrolled: z.boolean(),
  enrolledAt: isoTimestamp.nullable(),
});

/** E21: respuesta de `POST /2fa/disable`. */
export const disableResponseSchema = z.object({
  disabled: z.literal(true),
});

/** E21: respuesta de `POST /2fa/backup-codes/regenerate` -- mismos códigos en claro que `enrollResponseSchema.backupCodes`, mostrados UNA sola vez. */
export const regenerateBackupCodesResponseSchema = z.object({
  backupCodes: z.array(z.string()),
});
