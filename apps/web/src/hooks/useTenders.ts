import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import * as api from "@/lib/api/tenders";

export function useTenders(filters: api.TenderListFilters) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["tenders", "list", currentOrgId, filters],
    queryFn: () => api.listTenders(currentOrgId!, filters),
    enabled: Boolean(currentOrgId),
    placeholderData: (previous) => previous,
  });
}

export function useTender(id: string | null) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["tenders", "detail", currentOrgId, id],
    queryFn: () => api.getTender(currentOrgId!, id!),
    enabled: Boolean(currentOrgId) && Boolean(id),
  });
}

export function useTenderVersions(id: string | null) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["tenders", "versions", currentOrgId, id],
    queryFn: () => api.listTenderVersions(currentOrgId!, id!),
    enabled: Boolean(currentOrgId) && Boolean(id),
  });
}

export function useTenderChangeEvents(id: string | null) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["tenders", "change-events", currentOrgId, id],
    queryFn: () => api.listTenderChangeEvents(currentOrgId!, id!),
    enabled: Boolean(currentOrgId) && Boolean(id),
  });
}

/** No requiere organización: frescura de fuente pública, ver apps/api/README.md. */
export function useSourceFreshness() {
  return useQuery({
    queryKey: ["tenders", "sources-freshness"],
    queryFn: () => api.listSourceFreshness(),
  });
}
