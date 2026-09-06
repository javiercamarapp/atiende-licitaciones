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

/**
 * R5-09: la organización activa (`currentOrgId`, para `X-Org-Id`) y el
 * `purpose` de la acción concreta (declarado por el llamador, ver
 * `StepUpDialog`) viajan SIEMPRE -- sin ellos, la sesión de step-up
 * resultante queda "genérica" del lado del servidor y sirve para aprobar
 * cualquier tarifa/expediente de cualquier organización dentro de su
 * vigencia (ver docstring de `verifyStepUp` en lib/api/twofa.ts).
 */
export function useVerifyStepUp() {
  const { currentOrgId } = useAuth();
  return useMutation({
    mutationFn: ({ code, purpose }: { code: string; purpose: string }) => {
      if (!currentOrgId) throw new Error("No hay una organización activa para pedir el step-up.");
      return verifyStepUp(code, currentOrgId, purpose);
    },
  });
}
