import { z } from 'zod';
import { isoTimestamp, nullableIsoTimestamp, realCalendarDateString } from '../../lib/schema-helpers.js';

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
  // R5-07 (BAJA): antes solo validaba el PATRÓN "YYYY-MM-DD" -- una fecha
  // inexistente como "2026-02-30" pasaba la validación de Zod y reventaba
  // en Postgres con un 500 ("date/time field value out of range") en vez
  // de un 422 explícito de validación de cliente.
  date: realCalendarDateString,
  label: z.string().min(1),
  // R5-06 (BAJA): `z.string().url()` acepta cualquier esquema
  // (`javascript:...`, `data:...`, `ftp://...`). Solo superadmin escribe
  // esta tabla, pero si `apps/web` alguna vez renderiza `sourceUrl` como
  // enlace clicable sin sanitizar, un esquema no-http(s) abre un vector de
  // auto-XSS/descarga para quien abra ese enlace desde el back office.
  sourceUrl: z.string().url().refine((u) => /^https?:\/\//i.test(u), { message: 'sourceUrl debe usar esquema http o https' }),
  sourceConsultedOn: realCalendarDateString,
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

// ---------------------------------------------------------------------------
// REQ-026/REQ-111/REQ-112: KYC negativo (lista 69-B) y fingerprint de
// interpósita persona -- visibilidad de compliance para superadmin (las
// tablas crudas de packages/db/migrations/0099/0100 son de solo
// superadmin/worker_role, ver README de packages/kyc).
// ---------------------------------------------------------------------------
/**
 * `sanctions_69b_snapshots.list_as_of_date` es una columna `date` (no
 * `timestamptz`): el driver (pg/PGlite) la devuelve como `Date`, igual que
 * documenta `isoTimestamp` arriba, pero a diferencia de un timestamp
 * completo, aquí el valor de negocio es solo "YYYY-MM-DD" (la fecha de
 * corte que el propio SAT publica) -- `.toISOString()` añadiría un
 * componente de hora falso (`T00:00:00.000Z`) que nunca existió.
 */
const nullableDateOnly = z
  .union([z.string(), z.date()])
  .nullable()
  .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v));

export const adminKycListFreshnessSchema = z.object({
  snapshotId: z.string().uuid().nullable(),
  fetchedAt: nullableIsoTimestamp,
  listAsOfDate: nullableDateOnly,
  recordCount: z.number().nullable(),
  ageSeconds: z.number().nullable(),
  // REQ-026 literal: "alerta si listas >48h desactualizadas" -- mismo
  // criterio que `adminConnectorFreshnessSchema.isStale` (REQ-149).
  isStale: z.boolean(),
});

export const adminKycTenantStatusSchema = z.object({
  orgId: z.string().uuid(),
  orgName: z.string(),
  verdict: z.enum(['clear', 'flagged', 'suspended']),
  reason: z.string().nullable(),
  updatedAt: isoTimestamp,
});

export const adminKycFingerprintMatchSchema = z.object({
  orgIdA: z.string().uuid(),
  orgNameA: z.string(),
  orgIdB: z.string().uuid(),
  orgNameB: z.string(),
  score: z.number(),
  matchedFields: z.array(z.object({ field: z.string(), value: z.string() })),
  detectedAt: isoTimestamp,
  status: z.string(),
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
