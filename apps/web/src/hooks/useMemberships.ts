// Ronda 5: `GET /organizations/:orgId/memberships` (ronda 4 de apps/api)
// cierra el hueco documentado en README ("Usuarios y roles" quedaba
// honestamente vacía por falta de este endpoint). Visible para cualquier
// rol activo (member+); cambiar rol/eliminar exige owner/admin, reforzado
// también en la propia API (403 real si no).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import * as api from "@/lib/api/organizations";
import type { Invitation, OrgRole } from "@/lib/api/schemas";

export function useMemberships() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["organizations", "memberships", currentOrgId],
    queryFn: () => api.listMemberships(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}

export function useChangeMembershipRole() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: OrgRole }) => api.changeMembershipRole(currentOrgId!, userId, role),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["organizations", "memberships", currentOrgId] }),
  });
}

export function useRemoveMembership() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.removeMembership(currentOrgId!, userId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["organizations", "memberships", currentOrgId] }),
  });
}

/**
 * `POST /organizations/invitations`: el token en claro solo se devuelve UNA
 * vez en la respuesta (ver apps/api/README.md) -- no se persiste en ningún
 * lado, por lo que la propia mutación es el único momento en que la UI
 * puede mostrarlo (ver UsuariosRolesPage.tsx).
 */
export function useInviteMember() {
  const { currentOrgId } = useAuth();
  return useMutation<Invitation, unknown, { email: string; role: OrgRole }>({
    mutationFn: (input) => api.inviteMember(currentOrgId!, input),
  });
}
