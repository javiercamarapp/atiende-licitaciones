import { z } from 'zod';
import { isoTimestamp, nullableIsoTimestamp } from '../../lib/schema-helpers.js';

export const adminOrgSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  createdAt: isoTimestamp,
  memberCount: z.number(),
});

export const adminConnectorFreshnessSchema = z.object({
  sourceId: z.string(),
  status: z.string(),
  lastSuccessAt: nullableIsoTimestamp,
  startedAt: isoTimestamp,
  finishedAt: nullableIsoTimestamp,
  attempts: z.number(),
  ageSeconds: z.number().nullable(),
  // Métrica honesta (REQ-169): frescura real, sin proyección optimista.
  isStale: z.boolean(),
});

export const adminJobSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid().nullable(),
  kind: z.string(),
  status: z.string(),
  attempts: z.number(),
  maxAttempts: z.number(),
  lastError: z.string().nullable(),
  nextRunAt: isoTimestamp,
  createdAt: isoTimestamp,
});

export const adminCostByOrgSchema = z.object({
  orgId: z.string().uuid(),
  orgName: z.string(),
  totalRuns: z.number(),
  totalEstimatedCostUsd: z.number(),
  // REQ-169: se marca explícitamente como estimado (viene de
  // estimated_cost_usd, nunca facturación real de un proveedor).
  estimated: z.literal(true),
});

export const incidentCreateSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  orgId: z.string().uuid().optional(),
});

export const incidentSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  severity: z.string(),
  status: z.string(),
  createdAt: isoTimestamp,
  resolvedAt: nullableIsoTimestamp,
});

export const pendingApprovalSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  orgName: z.string(),
  toolName: z.string(),
  agentRunId: z.string().uuid(),
  createdAt: isoTimestamp,
});
