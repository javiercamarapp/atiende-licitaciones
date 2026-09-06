import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import * as api from "@/lib/api/go-no-go";

export function useGoNoGoDecisions(tenderId: string | null) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["go-no-go", currentOrgId, tenderId],
    queryFn: () => api.listGoNoGoDecisions(currentOrgId!, tenderId!),
    enabled: Boolean(currentOrgId) && Boolean(tenderId),
  });
}

export function useCreateGoNoGoDecision(tenderId: string | null) {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: api.GoNoGoInput) => api.createGoNoGoDecision(currentOrgId!, tenderId!, input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["go-no-go", currentOrgId, tenderId] }),
  });
}
