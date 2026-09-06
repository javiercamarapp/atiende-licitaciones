import { apiRequest } from "./client";
import {
  tenderSchema,
  tenderListResponseSchema,
  tenderVersionSchema,
  tenderChangeEventSchema,
  sourceFreshnessSchema,
  type Tender,
  type TenderListResponse,
  type TenderVersion,
  type TenderChangeEvent,
  type SourceFreshness,
  type TenderStatus,
} from "./schemas";
import { z } from "zod";

export interface TenderListFilters {
  status?: TenderStatus;
  source?: string;
  cursor?: string;
  limit?: number;
}

export async function listTenders(orgId: string, filters: TenderListFilters = {}): Promise<TenderListResponse> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.source) params.set("source", filters.source);
  if (filters.cursor) params.set("cursor", filters.cursor);
  if (filters.limit) params.set("limit", String(filters.limit));
  const query = params.toString();
  const raw = await apiRequest<unknown>(`/tenders${query ? `?${query}` : ""}`, { orgId });
  return tenderListResponseSchema.parse(raw);
}

export async function getTender(orgId: string, id: string): Promise<Tender> {
  const raw = await apiRequest<unknown>(`/tenders/${id}`, { orgId });
  return tenderSchema.parse(raw);
}

export async function listTenderVersions(orgId: string, id: string): Promise<TenderVersion[]> {
  const raw = await apiRequest<unknown>(`/tenders/${id}/versions`, { orgId });
  return z.array(tenderVersionSchema).parse(raw);
}

export async function listTenderChangeEvents(orgId: string, id: string): Promise<TenderChangeEvent[]> {
  const raw = await apiRequest<unknown>(`/tenders/${id}/change-events`, { orgId });
  return z.array(tenderChangeEventSchema).parse(raw);
}

/** Frescura por fuente: cualquier usuario autenticado, sin X-Org-Id (no es un dato de tenant). */
export async function listSourceFreshness(): Promise<SourceFreshness[]> {
  const raw = await apiRequest<unknown>("/tenders/sources/freshness");
  return z.array(sourceFreshnessSchema).parse(raw);
}
