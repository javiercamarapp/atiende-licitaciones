import { apiRequest } from "./client";
import { matchResultSchema, matchListResponseSchema, type MatchResult } from "./schemas";

export async function getTenderMatch(orgId: string, tenderId: string): Promise<MatchResult> {
  const raw = await apiRequest<unknown>(`/matching/tenders/${tenderId}`, { orgId });
  return matchResultSchema.parse(raw);
}

export async function listTenderMatches(orgId: string): Promise<MatchResult[]> {
  const raw = await apiRequest<unknown>("/matching/tenders", { orgId });
  return matchListResponseSchema.parse(raw).items;
}
