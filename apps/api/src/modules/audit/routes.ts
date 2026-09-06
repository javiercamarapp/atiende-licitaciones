/**
 * Ronda 4 (docs/logs/api-ronda4.log): apps/web (README, sección "Endpoints
 * de apps/api que SÍ existen pero no se pudieron conectar") señaló que
 * `audit_log` (bitácora append-only con hash encadenado, ver
 * `packages/db/README.md`, `app.verify_audit_log_chain()`) se escribe en
 * cada mutación relevante pero no tenía NINGÚN endpoint HTTP para leerla.
 *
 * `GET /audit-log` expone la bitácora de la organización activa
 * (`X-Org-Id`), restringida en la aplicación a `reviewer`/`admin`/`owner`
 * -- más estricto que la RLS real de `audit_log` (0008_rls_policies.sql,
 * `sel_audit_log`: cualquier rol de la organización, incluido `viewer`,
 * puede verla), mismo patrón que ya usa esta API para otras acciones
 * "más sensibles que su propio RLS" (p. ej. aprobar una `approved_rate`).
 * La contraparte de plataforma (`GET /admin/audit-log`, superadmin, TODAS
 * las organizaciones) vive en `modules/admin/routes.ts` reutilizando estos
 * mismos esquemas.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { OrgRole } from '@atiende/db';
import { BadRequestError, ForbiddenError } from '../../lib/errors.js';
import { encodeCursor, decodeCursor, parsePageSize, toIsoString } from '../../lib/cursor.js';
import { auditLogListQuerySchema, auditLogListResponseSchema } from './schemas.js';

const AUDIT_LOG_READ_ROLES: OrgRole[] = ['owner', 'admin', 'reviewer'];

function mapAuditLogRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    orgId: r.org_id,
    actorId: r.actor_id,
    action: r.action,
    entity: r.entity,
    entityId: r.entity_id,
    before: r.before ?? null,
    after: r.after ?? null,
    requestId: r.request_id,
    correlationId: r.correlation_id ?? null,
    createdAt: r.created_at,
  };
}

/** Valida `value` (si viene) como fecha real; lanza 400 explícito en vez de dejar que Postgres reviente el casteo. */
function parseDateFilter(value: string | undefined, label: string): Date | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestError(`${label} no es una fecha válida: "${value}"`);
  }
  return date;
}

export async function auditLogRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/audit-log',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: {
        description:
          'Bitácora de auditoría de la organización activa (append-only, hash encadenado). Requiere reviewer/admin/owner.',
        querystring: auditLogListQuerySchema,
        response: { 200: auditLogListResponseSchema },
      },
    },
    async (request) => {
      const orgId = request.orgId!;
      if (!request.orgRole || !AUDIT_LOG_READ_ROLES.includes(request.orgRole)) {
        throw new ForbiddenError('Solo reviewer/admin/owner pueden leer la bitácora de auditoría de esta organización');
      }
      const { entity, actorId, correlationId, cursor, limit } = request.query;
      const createdFrom = parseDateFilter(request.query.createdFrom, 'createdFrom');
      const createdTo = parseDateFilter(request.query.createdTo, 'createdTo');
      const pageSize = parsePageSize(limit);
      const decoded = cursor ? decodeCursor(cursor) : null;

      const conditions: string[] = ['org_id = $1'];
      const params: unknown[] = [orgId];
      if (entity) {
        params.push(entity);
        conditions.push(`entity = $${params.length}`);
      }
      if (actorId) {
        params.push(actorId);
        conditions.push(`actor_id = $${params.length}`);
      }
      if (correlationId) {
        params.push(correlationId);
        conditions.push(`correlation_id = $${params.length}`);
      }
      if (createdFrom) {
        params.push(createdFrom.toISOString());
        conditions.push(`created_at >= $${params.length}::timestamptz`);
      }
      if (createdTo) {
        params.push(createdTo.toISOString());
        conditions.push(`created_at <= $${params.length}::timestamptz`);
      }
      // Orden DESCENDENTE (lo más reciente primero, uso natural de una
      // bitácora): el cursor avanza hacia atrás en el tiempo con `<`.
      if (decoded) {
        params.push(decoded.sortKey, decoded.id);
        conditions.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(pageSize + 1);

      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<Record<string, unknown>>(
          `select * from audit_log where ${conditions.join(' and ')} order by created_at desc, id desc limit $${params.length}`,
          params
        );
      });

      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      const last = page[page.length - 1] as Record<string, unknown> | undefined;
      const nextCursor = hasMore && last ? encodeCursor(toIsoString(last.created_at), String(last.id)) : null;
      return { items: page.map(mapAuditLogRow), nextCursor };
    }
  );
}

export { mapAuditLogRow, parseDateFilter, AUDIT_LOG_READ_ROLES };
