import { apiRequest } from "./client";
import { goNoGoDecisionSchema, type GoNoGoDecision } from "./schemas";
import { z } from "zod";

export async function listGoNoGoDecisions(orgId: string, tenderId: string): Promise<GoNoGoDecision[]> {
  const raw = await apiRequest<unknown>(`/tenders/${tenderId}/go-no-go`, { orgId });
  return z.array(goNoGoDecisionSchema).parse(raw);
}

export interface GoNoGoInput {
  decision: "go" | "no_go";
  reasons: string[];
}

export async function createGoNoGoDecision(orgId: string, tenderId: string, input: GoNoGoInput): Promise<GoNoGoDecision> {
  const raw = await apiRequest<unknown>(`/tenders/${tenderId}/go-no-go`, { method: "POST", body: input, orgId });
  return goNoGoDecisionSchema.parse(raw);
}
