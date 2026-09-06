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
