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
   * R5-05 (docs/auditoria-2/api-ronda5.md, BAJA-MEDIA): opcional, para
   * atar explícitamente el `stepUpToken` resultante a una ACCIÓN concreta
   * (p.ej. "company.rate_approval", "expediente.approval"). Si se omite
   * (comportamiento previo, preservado para no romper clientes existentes),
   * la sesión queda "genérica" -- utilizable para cualquier acción, dentro
   * de la ventana de vigencia, tal como funcionaba antes de esta ronda. Si
   * se declara, `requireStepUp` (lib/step-up.ts) EXIGE que la acción que
   * consuma el token declare el MISMO `purpose`, o lo rechaza -- cierra el
   * hueco de "un token emitido una vez sirve para aprobar cualquier número
   * de tarifas/expedientes distintos" para el cliente que decida usarlo.
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
