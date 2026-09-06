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

export async function verifyTwoFactorEnrollment(code: string): Promise<VerifyEnrollmentResponse> {
  const raw = await apiRequest<unknown>("/auth/2fa/verify-enrollment", { method: "POST", body: { code } });
  return verifyEnrollmentResponseSchema.parse(raw);
}

/** Acepta un código TOTP de 6 dígitos O un código de respaldo "XXXX-XXXX" (un solo uso). */
export async function verifyStepUp(code: string): Promise<StepUpResponse> {
  const raw = await apiRequest<unknown>("/auth/2fa/step-up", { method: "POST", body: { code } });
  return stepUpResponseSchema.parse(raw);
}
