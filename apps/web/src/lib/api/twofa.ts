// 2FA/step-up TOTP (REQ-044/064): enrolamiento de la CUENTA (no depende de
// `X-Org-Id` -- válido para cualquier organización de la que el usuario sea
// miembro) y verificación de step-up, exigida por apps/api antes de
// aprobar una tarifa (`POST /company/rates/:id/approve`) o un expediente
// (`POST .../approval/approve`) vía el encabezado `X-Step-Up`.
import { apiRequest } from "./client";
import {
  stepUpStatusSchema,
  enrollTwoFactorResponseSchema,
  verifyEnrollmentResponseSchema,
  stepUpResponseSchema,
  type StepUpStatus,
  type EnrollTwoFactorResponse,
  type VerifyEnrollmentResponse,
  type StepUpResponse,
} from "./schemas";

export async function getTwoFactorStatus(): Promise<StepUpStatus> {
  const raw = await apiRequest<unknown>("/auth/2fa/status");
  return stepUpStatusSchema.parse(raw);
}

export async function enrollTwoFactor(): Promise<EnrollTwoFactorResponse> {
  const raw = await apiRequest<unknown>("/auth/2fa/enroll", { method: "POST" });
  return enrollTwoFactorResponseSchema.parse(raw);
}

/**
 * Confirmar el enrolamiento también emite una sesión de step-up (misma
 * fila de `step_up_sessions` que un step-up normal, ver docstring del
 * schema) -- migraciones 0062/0063 (R5-09) hicieron `org_id`/`purpose`
 * NOT NULL ahí a nivel de esquema, así que declarar ambos es OBLIGATORIO
 * para no recibir un 500 real de "null value in column org_id" (la ruta
 * `/2fa/verify-enrollment` en sí no fue actualizada para EXIGIRLOS a nivel
 * de aplicación como sí lo está `/2fa/step-up`, pero igual los lee del
 * header/body si vienen). `purpose` es fijo (`"admin.action"`, el más
 * genérico de la lista cerrada de apps/api -- confirmar el enrolamiento no
 * autoriza ninguna acción de negocio concreta todavía).
 */
export async function verifyTwoFactorEnrollment(code: string, orgId: string): Promise<VerifyEnrollmentResponse> {
  const raw = await apiRequest<unknown>("/auth/2fa/verify-enrollment", {
    method: "POST",
    body: { code, purpose: "admin.action" },
    orgId,
  });
  return verifyEnrollmentResponseSchema.parse(raw);
}

/**
 * Acepta un código TOTP de 6 dígitos O un código de respaldo "XXXX-XXXX"
 * (un solo uso).
 *
 * R5-09 (reverificación api ronda 5): declara SIEMPRE la organización
 * activa (`X-Org-Id`, vía `orgId`) y un `purpose` específico de la acción
 * que se autoriza (p. ej. `"company.rate_approval"`,
 * `"expediente.approval"` -- deben coincidir EXACTAMENTE con el `purpose`
 * que la ruta que consume `X-Step-Up` exige, ver
 * apps/api/src/lib/step-up.ts `requireStepUp`). Antes de esta ronda ninguno
 * de los dos viajaba, así que la sesión de step-up quedaba "genérica" del
 * lado del servidor (servía para aprobar cualquier tarifa/expediente de
 * cualquier organización dentro de su vigencia) — apps/api pasará a
 * exigirlos (403 si faltan).
 */
export async function verifyStepUp(code: string, orgId: string, purpose: string): Promise<StepUpResponse> {
  const raw = await apiRequest<unknown>("/auth/2fa/step-up", { method: "POST", body: { code, purpose }, orgId });
  return stepUpResponseSchema.parse(raw);
}
