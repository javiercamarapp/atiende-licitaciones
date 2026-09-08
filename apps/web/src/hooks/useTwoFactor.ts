// 2FA/step-up TOTP (REQ-044/064). Enrolamiento de CUENTA (no depende de
// `currentOrgId`): válido para cualquier organización de la que el usuario
// sea miembro, ver apps/api/src/modules/twofa/routes.ts.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import { getTwoFactorStatus, enrollTwoFactor, verifyTwoFactorEnrollment, verifyStepUp, disableTwoFactor, regenerateBackupCodes } from "@/lib/api/twofa";

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

/**
 * Confirmar el enrolamiento exige una organización activa (ver docstring
 * de `verifyTwoFactorEnrollment` en lib/api/twofa.ts: la migración 0062
 * hizo `org_id` NOT NULL en la sesión de step-up que esta llamada también
 * emite) -- un usuario que aún no pertenece a ninguna organización no
 * puede completar el enrolamiento todavía.
 */
export function useVerifyTwoFactorEnrollment() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => {
      if (!currentOrgId) throw new Error("Necesitas una organización activa para confirmar el enrolamiento de 2FA.");
      return verifyTwoFactorEnrollment(code, currentOrgId);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["auth", "2fa", "status"] }),
  });
}

/**
 * R5-09: la organización (para `X-Org-Id`) y el `purpose` de la acción
 * concreta (declarado por el llamador, ver `StepUpDialog`) viajan SIEMPRE --
 * sin ellos, la sesión de step-up resultante queda "genérica" del lado del
 * servidor y sirve para aprobar cualquier tarifa/expediente de cualquier
 * organización dentro de su vigencia (ver docstring de `verifyStepUp` en
 * lib/api/twofa.ts).
 *
 * RF-01 (docs/auditoria-2/ronda5-final.md): por defecto usa la
 * organización activa (`currentOrgId`, mismo comportamiento que antes de
 * esta ronda), pero acepta un `orgId` explícito que la sobreescribe --
 * necesario para la aprobación CROSS-ORG de tool_calls
 * (AprobacionesBackofficePage): `requireStepUp` exige que la sesión esté
 * atada EXACTO a la organización dueña de la tool_call, no a la
 * organización activa del superadmin (que puede ser otra o no existir).
 */
export function useVerifyStepUp() {
  const { currentOrgId } = useAuth();
  return useMutation({
    mutationFn: ({ code, purpose, orgId }: { code: string; purpose: string; orgId?: string }) => {
      const targetOrgId = orgId ?? currentOrgId;
      if (!targetOrgId) throw new Error("No hay una organización activa para pedir el step-up.");
      return verifyStepUp(code, targetOrgId, purpose);
    },
  });
}

/**
 * E21 (docs/BACKLOG.md): desactivar 2FA de la cuenta propia -- exige un
 * `stepUpToken` ya verificado (purpose `twofa.disable`, ver StepUpDialog en
 * ConfiguracionPage). apps/api rechaza con 409 si la cuenta se quedaría sin
 * ningún método de acceso (sin contraseña ni Google) -- ese rechazo llega
 * tal cual como `ApiError`, la pantalla lo muestra con `describeApiError`.
 */
export function useDisableTwoFactor() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (stepUpToken: string) => {
      if (!currentOrgId) throw new Error("Necesitas una organización activa para desactivar 2FA.");
      return disableTwoFactor(currentOrgId, stepUpToken);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["auth", "2fa", "status"] }),
  });
}

/** E21: regenerar códigos de respaldo -- reemplaza por completo los anteriores (invalidación real en DB). */
export function useRegenerateBackupCodes() {
  const { currentOrgId } = useAuth();
  return useMutation({
    mutationFn: (stepUpToken: string) => {
      if (!currentOrgId) throw new Error("Necesitas una organización activa para regenerar tus códigos de respaldo.");
      return regenerateBackupCodes(currentOrgId, stepUpToken);
    },
  });
}
