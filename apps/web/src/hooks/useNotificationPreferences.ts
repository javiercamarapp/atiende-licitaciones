// REQ-187 (ronda 8b): preferencias de notificación por correo del PROPIO
// usuario (`GET`/`PUT /mail/preferences`). Son de la CUENTA, no de la
// organización activa: la API las lee y escribe con el `userId` del access
// token y no acepta ningún `X-Org-Id` — por eso la `queryKey` no lleva
// `currentOrgId` (mismo criterio que `useTwoFactorStatus`).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
} from "@/lib/api/mail";

export const NOTIFICATION_PREFERENCES_KEY = ["mail", "preferences"] as const;

/**
 * `enabled: authStatus === "authenticated"` por el mismo motivo que
 * `useTwoFactorStatus`: sin esa guarda la query dispara antes de que
 * `AuthProvider` termine de rotar el refresh token y falla una vez con "No
 * hay una sesión activa", dejando la tarjeta con un error que no
 * corresponde a nada real.
 */
export function useNotificationPreferences() {
  const { status: authStatus } = useAuth();
  return useQuery({
    queryKey: NOTIFICATION_PREFERENCES_KEY,
    queryFn: getNotificationPreferences,
    enabled: authStatus === "authenticated",
  });
}

/**
 * La respuesta del `PUT` es el estado COMPLETO ya persistido, así que se
 * escribe directo en la caché (`setQueryData`) en vez de invalidar: evita
 * un segundo viaje y, sobre todo, evita el parpadeo de volver al valor
 * anterior mientras llega el refetch. No hay actualización optimista a
 * propósito — si el `PUT` falla, el interruptor debe quedarse donde estaba,
 * no mentir sobre un cambio que el servidor no aceptó.
 */
export function useUpdateNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<NotificationPreferences>) => updateNotificationPreferences(patch),
    onSuccess: (preferences) => queryClient.setQueryData(NOTIFICATION_PREFERENCES_KEY, preferences),
  });
}
