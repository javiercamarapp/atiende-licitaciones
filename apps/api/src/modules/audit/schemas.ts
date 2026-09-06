import { z } from 'zod';
import { isoTimestamp } from '../../lib/schema-helpers.js';

export const auditLogEntrySchema = z.object({
  id: z.string().uuid(),
  // `null` para eventos de plataforma sin organización asociada (ver
  // API-10, `lib/audit.ts`) -- solo puede ocurrir en `/admin/audit-log`
  // (superadmin, todas las organizaciones); `GET /audit-log` (de una
  // organización) nunca devuelve una fila con `orgId: null` porque siempre
  // filtra por la organización activa.
  orgId: z.string().uuid().nullable(),
  actorId: z.string().uuid().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  requestId: z.string().nullable(),
  /** REQ-171: id de correlación de negocio (ver `plugins/correlation-id.plugin.ts`); `null` para eventos anteriores a esta ronda o sin correlación conocida. */
  correlationId: z.string().nullable(),
  createdAt: isoTimestamp,
});

export const auditLogListQuerySchema = z.object({
  entity: z.string().optional(),
  actorId: z.string().uuid().optional(),
  /** REQ-171: filtra la bitácora por id de correlación -- reconstruye la traza completa de un flujo (convocatoria -> matriz -> propuesta -> paquete -> archivo). */
  correlationId: z.string().optional(),
  // Strings ISO libres (no `z.string().datetime()` a secas para admitir
  // tanto fecha-hora completa como fecha simple "AAAA-MM-DD"); se valida
  // con `new Date(...)` en el handler y se rechaza con 400 explícito si no
  // es una fecha real, en vez de dejar que Postgres lance un error de casteo.
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  cursor: z.string().optional(),
  // Nota (igual que `tenderListQuerySchema`): sin `z.coerce.number()` a
  // propósito -- rompe la generación de OpenAPI (`@fastify/swagger` +
  // `fastify-type-provider-zod`).
  limit: z
    .string()
    .regex(/^\d+$/, 'limit debe ser un entero positivo')
    .optional(),
});

export const adminAuditLogListQuerySchema = auditLogListQuerySchema.extend({
  orgId: z.string().uuid().optional(),
});

export const auditLogListResponseSchema = z.object({
  items: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
});
