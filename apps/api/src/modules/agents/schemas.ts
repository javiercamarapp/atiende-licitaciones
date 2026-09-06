import { z } from 'zod';
import { isoTimestamp, nullableIsoTimestamp } from '../../lib/schema-helpers.js';

export const agentRunSchema = z.object({
  id: z.string().uuid(),
  agentName: z.string(),
  status: z.string(),
  totalSteps: z.number(),
  completedSteps: z.number(),
  correlationId: z.string().nullable(),
  startedAt: isoTimestamp,
  finishedAt: nullableIsoTimestamp,
});

export const toolCallSchema = z.object({
  id: z.string().uuid(),
  agentRunId: z.string().uuid(),
  toolName: z.string(),
  authorizationStatus: z.enum(['auto', 'pending', 'approved', 'denied']),
  status: z.string().nullable(),
  approvedBy: z.string().uuid().nullable(),
  approvedAt: nullableIsoTimestamp,
  createdAt: isoTimestamp,
});

export const toolCallListQuerySchema = z.object({
  status: z.enum(['auto', 'pending', 'approved', 'denied']).optional(),
});
