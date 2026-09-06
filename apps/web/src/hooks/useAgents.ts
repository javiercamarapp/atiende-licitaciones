import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/hooks/useAuth";
import * as api from "@/lib/api/agents";
import type { ToolCall } from "@/lib/api/schemas";

export function useAgentRuns() {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["agents", "runs", currentOrgId],
    queryFn: () => api.listAgentRuns(currentOrgId!),
    enabled: Boolean(currentOrgId),
  });
}

export function useToolCalls(status?: ToolCall["authorizationStatus"]) {
  const { currentOrgId } = useAuth();
  return useQuery({
    queryKey: ["agents", "tool-calls", currentOrgId, status ?? "all"],
    queryFn: () => api.listToolCalls(currentOrgId!, status),
    enabled: Boolean(currentOrgId),
  });
}

export function useApproveToolCall() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.approveToolCall(currentOrgId!, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", "tool-calls", currentOrgId] }),
  });
}

export function useDenyToolCall() {
  const { currentOrgId } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.denyToolCall(currentOrgId!, id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["agents", "tool-calls", currentOrgId] }),
  });
}
