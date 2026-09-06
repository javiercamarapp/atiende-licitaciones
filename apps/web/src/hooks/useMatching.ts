import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import * as api from "@/lib/api/matching";

export function useTenderMatches() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["matching", "list", currentOrgId],
    queryFn: () => api.listTenderMatches(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}

export function useTenderMatch(tenderId: string | null) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["matching", "detail", currentOrgId, tenderId],
    queryFn: () => api.getTenderMatch(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId) && Boolean(tenderId),
  });
}
