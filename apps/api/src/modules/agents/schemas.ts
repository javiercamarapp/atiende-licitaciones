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
  /**
   * Punto 3 (completar ciclo redactor_borrador): distingue explícitamente
   * una corrida que usó `FakeProvider` (sin `OPENAI_API_KEY`) de una con
   * proveedor real, derivado de `agent_runs.output` (ver
   * `computeProviderMeta`, apps/worker/src/handlers/run-agent.ts) — `null`
   * mientras la corrida no ha terminado (`output` todavía vacío) o para
   * corridas de antes de esta ronda que no lo persistieron.
   */
  providerId: z.string().nullable(),
  simulated: z.boolean().nullable(),
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
