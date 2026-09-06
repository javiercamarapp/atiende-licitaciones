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

// RF-01 (docs/auditoria-2/ronda5-final.md): R5-11 (apps/api, commit 428797f)
// exige `X-Step-Up` (`purpose: "tool_call.approval"`) en estas dos rutas --
// `stepUpToken` es OBLIGATORIO aquí (nunca opcional): sin él, apps/api
// responde 403 siempre que exista una tool_call pendiente real.
export async function approveToolCall(orgId: string, id: string, stepUpToken: string): Promise<ToolCall> {
  const raw = await apiRequest<unknown>(`/agents/tool-calls/${id}/approve`, { method: "POST", orgId, stepUpToken });
  return toolCallSchema.parse(raw);
}

export async function denyToolCall(orgId: string, id: string, stepUpToken: string): Promise<ToolCall> {
  const raw = await apiRequest<unknown>(`/agents/tool-calls/${id}/deny`, { method: "POST", orgId, stepUpToken });
  return toolCallSchema.parse(raw);
}
