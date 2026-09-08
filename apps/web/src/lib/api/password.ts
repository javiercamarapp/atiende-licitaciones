// E21 (docs/BACKLOG.md): cambiar la contraseña de la propia cuenta ESTANDO
// YA AUTENTICADO (distinto de `POST /auth/password/reset`, ver
// `lib/api/mail.ts` / `pages/auth/ResetPasswordPage.tsx`, que recupera el
// acceso vía enlace de correo cuando la contraseña se olvidó).
import { apiRequest } from "./client";
import { changePasswordResponseSchema, type ChangePasswordResponse } from "./schemas";

export interface ChangePasswordPayload {
  currentPassword: string;
  newPassword: string;
}

/**
 * `POST /auth/password/change` (apps/api/src/modules/auth/password.routes.ts):
 * exige un `stepUpToken` vigente (purpose `auth.password_change`) vía
 * `X-Step-Up` ADEMÁS de la contraseña actual en el cuerpo -- dos capas, ni
 * el step-up ni la contraseña actual bastan por sí solos. Éxito revoca
 * TODAS las sesiones activas de la cuenta, este dispositivo incluido: el
 * llamador debe tratar la respuesta como el fin de la sesión actual (ver
 * `useChangePassword` en `hooks/useAccountSecurity.ts`).
 */
export async function changePassword(payload: ChangePasswordPayload, orgId: string, stepUpToken: string): Promise<ChangePasswordResponse> {
  const raw = await apiRequest<unknown>("/auth/password/change", { method: "POST", body: payload, orgId, stepUpToken });
  return changePasswordResponseSchema.parse(raw);
}
