import { apiRequest } from "./client";
import { agentRunSchema, toolCallSchema, type AgentRun, type ToolCall } from "./schemas";
import { z } from "zod";

export async function listAgentRuns(orgId: string): Promise<AgentRun[]> {
  const raw = await apiRequest<unknown>("/agents/runs", { orgId });
  return z.array(agentRunSchema).parse(raw);
}

export async function listToolCalls(orgId: string, status?: ToolCall["authorizationStatus"]): Promise<ToolCall[]> {
  const query = status ? `?status=${status}` : "";
  const raw = await apiRequest<unknown>(`/agents/tool-calls${query}`, { orgId });
  return z.array(toolCallSchema).parse(raw);
}

export async function approveToolCall(orgId: string, id: string): Promise<ToolCall> {
  const raw = await apiRequest<unknown>(`/agents/tool-calls/${id}/approve`, { method: "POST", orgId });
  return toolCallSchema.parse(raw);
}

export async function denyToolCall(orgId: string, id: string): Promise<ToolCall> {
  const raw = await apiRequest<unknown>(`/agents/tool-calls/${id}/deny`, { method: "POST", orgId });
  return toolCallSchema.parse(raw);
}
