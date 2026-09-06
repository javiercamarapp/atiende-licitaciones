// 2FA/step-up TOTP (REQ-044/064). Enrolamiento de CUENTA (no depende de
// `currentOrgId`): válido para cualquier organización de la que el usuario
// sea miembro, ver apps/api/src/modules/twofa/routes.ts.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import { getTwoFactorStatus, enrollTwoFactor, verifyTwoFactorEnrollment, verifyStepUp } from "@/lib/api/twofa";

/**
 * `enabled: status === "authenticated"` (mismo patrón que hooks/useAdmin.ts,
 * ronda 5): `StepUpDialog` está SIEMPRE montado dentro de la página que lo
 * usa (no solo cuando `open` es true, ver TarifasAprobadasPage/RevisionPage),
 * así que esta query dispara desde el primer render -- sin esta guarda,
 * corre ANTES de que `AuthProvider` termine de rotar el refresh token
 * guardado y consiga un access token real, falla una vez con "No hay una
 * sesión activa" y (sin `retry` en el cliente de pruebas) se queda así para
 * siempre, dejando el modal sin contenido ni error visibles.
 */
export function useTwoFactorStatus() {
  const { status: authStatus } = useAuth();
  return useQuery({ queryKey: ["auth", "2fa", "status"], queryFn: getTwoFactorStatus, enabled: authStatus === "authenticated" });
}

export function useEnrollTwoFactor() {
  return useMutation({ mutationFn: enrollTwoFactor });
}

export function useVerifyTwoFactorEnrollment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => verifyTwoFactorEnrollment(code),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["auth", "2fa", "status"] }),
  });
}

export function useVerifyStepUp() {
  return useMutation({ mutationFn: (code: string) => verifyStepUp(code) });
}
