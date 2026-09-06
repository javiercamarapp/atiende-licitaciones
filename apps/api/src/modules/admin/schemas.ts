import { z } from 'zod';
import { isoTimestamp, nullableIsoTimestamp } from '../../lib/schema-helpers.js';

/**
 * REQ-050/056 (E11): calendario OFICIAL de días inhábiles. Carga
 * administrativa explícita -- `sourceUrl`/`sourceConsultedOn` son
 * obligatorios porque el propio requisito prohíbe inventar una fecha "de
 * memoria" (ver docs/legal/verificacion-legal.md, que ya documenta que este
 * proyecto no pudo verificar en línea el calendario oficial completo en
 * esta ronda: la tabla se queda vacía hasta que alguien la cargue con una
 * fuente real).
 */
export const calendarHolidayCreateSchema = z.object({
  jurisdiction: z.string().min(1).default('federal'),
  year: z.number().int().min(2000).max(2100),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date debe ser "YYYY-MM-DD"'),
  label: z.string().min(1),
  sourceUrl: z.string().url(),
  sourceConsultedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'sourceConsultedOn debe ser "YYYY-MM-DD"'),
});

export const calendarHolidaySchema = z.object({
  id: z.string().uuid(),
  jurisdiction: z.string(),
  year: z.number(),
  date: isoTimestamp,
  label: z.string(),
  sourceUrl: z.string(),
  sourceConsultedOn: isoTimestamp,
  createdAt: isoTimestamp,
});

export const calendarHolidayListQuerySchema = z.object({
  jurisdiction: z.string().optional(),
  year: z
    .string()
    .regex(/^\d+$/, 'year debe ser un entero')
    .optional(),
});

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
