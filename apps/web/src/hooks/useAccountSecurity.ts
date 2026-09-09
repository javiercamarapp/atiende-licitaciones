// E19/E21 (docs/BACKLOG.md): sesiones activas propias, cambio de
// contraseña con step-up, y desvincular Google -- las tres piezas de
// ConfiguracionPage que faltaban además de 2FA (ver hooks/useTwoFactor.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import { getTokens } from "@/lib/api/session";
import { listAuthSessions, revokeAuthSession, revokeOtherAuthSessions } from "@/lib/api/auth-sessions";
import { changePassword, type ChangePasswordPayload } from "@/lib/api/password";
import { unlinkGoogle } from "@/lib/api/google";

/** Mismo criterio que `useTwoFactorStatus` (ver docstring ahí): solo dispara con sesión ya hidratada. */
export function useAuthSessions() {
  const { status } = useAuth();
  return useQuery({ queryKey: ["auth", "sessions"], queryFn: listAuthSessions, enabled: status === "authenticated" });
}

export function useRevokeAuthSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => revokeAuthSession(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] }),
  });
}

/**
 * `POST /auth/sessions/revoke-others`: usa el refresh token de ESTA
 * pestaña (`getTokens()`, `lib/api/session.ts`) como "la sesión a
 * preservar" -- el llamador no elige ninguna, apps/api la resuelve por
 * posesión de ese token.
 */
export function useRevokeOtherAuthSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      const { refreshToken } = getTokens();
      if (!refreshToken) throw new Error("No hay una sesión activa en este dispositivo.");
      return revokeOtherAuthSessions(refreshToken);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["auth", "sessions"] }),
  });
}

/**
 * E21: cambiar la contraseña propia -- exige un `stepUpToken` ya
 * verificado (purpose `auth.password_change`) ADEMÁS de la contraseña
 * actual. Éxito revoca TODAS las sesiones (ver docstring de
 * `lib/api/password.ts`) -- el llamador (ConfiguracionPage) debe cerrar la
 * sesión local justo después (`useAuth().logout()`), nunca dejar la app en
 * un estado "autenticado" con un refresh token que el servidor ya revocó.
 */
export function useChangePassword() {
  const { currentOrgId } = useAuth();
  return useMutation({
    mutationFn: ({ payload, stepUpToken }: { payload: ChangePasswordPayload; stepUpToken: string }) => {
      if (!currentOrgId) throw new Error("Necesitas una organización activa para cambiar tu contraseña.");
      return changePassword(payload, currentOrgId, stepUpToken);
    },
  });
}

/**
 * E19: desvincular Google -- exige un `stepUpToken` ya verificado (purpose
 * `auth.google_unlink`). apps/api rechaza con 409 si la cuenta se quedaría
 * sin ningún método de acceso (sin contraseña propia) -- ese rechazo llega
 * tal cual como `ApiError`. Invalida `["me"]` -- WI-03 no cubre este caso
 * puntual (GET /me no está en react-query en ningún otro lugar; lo
 * refresca directo `useAuth().refreshUser()` en el `onSuccess` del
 * llamador, no una query aparte).
 */
export function useUnlinkGoogle() {
  const { currentOrgId } = useAuth();
  return useMutation({
    mutationFn: (stepUpToken: string) => {
      if (!currentOrgId) throw new Error("Necesitas una organización activa para desvincular Google.");
      return unlinkGoogle(currentOrgId, stepUpToken);
    },
  });
}
