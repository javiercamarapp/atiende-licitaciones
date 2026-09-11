import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { isNegativeListStale } from '@atiende/kyc';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireStepUp } from '../../lib/step-up.js';
import { withOptionalEmptyJsonBody } from '../../lib/optional-empty-body.js';
import { encodeCursor, decodeCursor, parsePageSize, toIsoString } from '../../lib/cursor.js';
import { mapToolCall } from '../agents/routes.js';
import { toolCallSchema } from '../agents/schemas.js';
import { adminAuditLogListQuerySchema, auditLogListResponseSchema } from '../audit/schemas.js';
import { mapAuditLogRow, parseDateFilter } from '../audit/routes.js';
import {
  adminOrgSchema,
  adminConnectorFreshnessSchema,
  adminKycListFreshnessSchema,
  adminKycTenantStatusSchema,
  adminKycFingerprintMatchSchema,
  adminJobSchema,
  adminCostByOrgSchema,
  incidentCreateSchema,
  incidentSchema,
  pendingApprovalSchema,
  calendarHolidayCreateSchema,
  calendarHolidaySchema,
  calendarHolidayListQuerySchema,
} from './schemas.js';

/**
 * Back office / superadmin (E10, REQ-170): organizaciones, conectores y su
 * frescura, jobs (listar/reintentar), costos de IA por organización,
 * incidentes y aprobaciones pendientes. Todas las rutas están gateadas por
 * `app.requireSuperadmin` (platform_admins, ver plugins/superadmin.plugin.ts)
 * -- NUNCA por membresía de organización: un superadmin ve TODAS las
 * organizaciones, no solo la suya. Cada mutación queda en `audit_log`
 * SIEMPRE (con `org_id` de la organización afectada cuando aplica, o
 * `org_id = null` cuando el evento es verdaderamente plataforma-wide —
 * p.ej. reintentar un job de discovery sin organización — `audit_log.
 * org_id` acepta NULL desde la migración 0035, API-10 en
 * docs/auditoria-1/db-api-reverificacion.md: antes se omitía la
 * auditoría por completo en ese caso).
 *
 * Umbral de obsolescencia (REQ-149): 6 horas sin corrida exitosa se marca
 * `isStale=true`. Es un valor por defecto razonable, no configurable por
 * tenant en esta ronda (pendiente honesto).
 */
const STALE_THRESHOLD_SECONDS = 6 * 60 * 60;

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/organizations',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { response: { 200: z.array(adminOrgSchema) } },
    },
    async (request) => {
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<{ id: string; name: string; slug: string; created_at: string; member_count: string }>(
          `select o.id, o.name, o.slug, o.created_at, count(m.id)::text as member_count
           from organizations o
           left join memberships m on m.org_id = o.id and m.status = 'active'
           group by o.id
           order by o.created_at asc`
        );
      });
      return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, createdAt: r.created_at, memberCount: Number(r.member_count) }));
    }
  );

  server.get(
    '/connectors/freshness',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { response: { 200: z.array(adminConnectorFreshnessSchema) } },
    },
    async (request) => {
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        // Acceso directo a source_runs (no solo la vista agregada de
        // app.source_freshness expuesta a tenants): el back office puede ver
        // el detalle crudo completo, reservado a superadmin (0013).
        return tx.query<{
          source_id: string;
          status: string;
          last_success_at: string | null;
          started_at: string;
          finished_at: string | null;
          attempts: number;
        }>('select distinct on (source_id) * from source_runs order by source_id, started_at desc');
      });
      const now = Date.now();
      return rows.map((r) => {
        const ageSeconds = r.last_success_at ? Math.floor((now - new Date(r.last_success_at).getTime()) / 1000) : null;
        return {
          sourceId: r.source_id,
          status: r.status,
          lastSuccessAt: r.last_success_at,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          attempts: r.attempts,
          ageSeconds,
          // REQ-148: nunca se interpreta el silencio como "cero
          // oportunidades" -- sin corrida exitosa nunca, se marca obsoleta
          // explícitamente en vez de omitirse.
          isStale: ageSeconds === null || ageSeconds > STALE_THRESHOLD_SECONDS,
        };
      });
    }
  );

  server.get(
    '/jobs',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { querystring: z.object({ status: z.string().optional() }), response: { 200: z.array(adminJobSchema) } },
    },
    async (request) => {
      const { status } = request.query;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        if (status) {
          return tx.query('select * from jobs where status = $1 order by created_at desc limit 200', [status]);
        }
        return tx.query('select * from jobs order by created_at desc limit 200');
      });
      return rows.map((r: any) => ({
        id: r.id,
        orgId: r.org_id,
        kind: r.kind,
        status: r.status,
        attempts: r.attempts,
        maxAttempts: r.max_attempts,
        lastError: r.last_error,
        nextRunAt: r.next_run_at,
        createdAt: r.created_at,
      }));
    }
  );

  // Ronda 4: `/jobs/:id/retry` no lleva cuerpo -- tolera `Content-Type:
  // application/json` con cuerpo vacío (ver `lib/optional-empty-body.ts`).
  await withOptionalEmptyJsonBody(server, (scoped) => {
    scoped.withTypeProvider<ZodTypeProvider>().post(
      '/jobs/:id/retry',
      {
        preHandler: [app.authenticate, app.requireSuperadmin],
        schema: {
          description: 'Sin cuerpo (acepta Content-Type: application/json con cuerpo vacío).',
          params: z.object({ id: z.string().uuid() }),
          response: { 200: adminJobSchema },
        },
      },
      async (request) => {
        const row = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
          const before = await tx.query<{ status: string; org_id: string | null }>('select status, org_id from jobs where id = $1', [
            request.params.id,
          ]);
          if (before.rows.length === 0) return null;
          const updated = await tx.query(
            `update jobs set status = 'queued', next_run_at = now(), locked_at = null, locked_by = null, last_error = null
             where id = $1 returning *`,
            [request.params.id]
          );
          // API-10 (docs/auditoria-1/db-api-reverificacion.md): se audita
          // SIEMPRE, incluso cuando el job no tiene organización (jobs de
          // plataforma/discovery) -- `audit_log.org_id` acepta NULL desde la
          // migración 0035 precisamente para este caso.
          await recordAudit(tx, {
            orgId: before.rows[0].org_id,
            actorId: request.userId!,
            action: 'admin.job.retry',
            entity: 'jobs',
            entityId: request.params.id,
            before: { status: before.rows[0].status },
            after: { status: 'queued' },
            requestId: request.id, correlationId: request.correlationId,
          });
          return updated.rows[0];
        });
        if (!row) throw new NotFoundError('Job no encontrado');
        return {
          id: (row as any).id,
          orgId: (row as any).org_id,
          kind: (row as any).kind,
          status: (row as any).status,
          attempts: (row as any).attempts,
          maxAttempts: (row as any).max_attempts,
          lastError: (row as any).last_error,
          nextRunAt: (row as any).next_run_at,
          createdAt: (row as any).created_at,
        };
      }
    );
  });

  server.get(
    '/costs',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { response: { 200: z.array(adminCostByOrgSchema) } },
    },
    async (request) => {
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<{ org_id: string; org_name: string; total_runs: string; total_cost: string }>(
          `select o.id as org_id, o.name as org_name, count(ar.id)::text as total_runs,
                  coalesce(sum(ar.estimated_cost_usd), 0)::text as total_cost
           from organizations o
           left join agent_runs ar on ar.org_id = o.id
           group by o.id
           order by total_cost desc`
        );
      });
      return rows.map((r) => ({
        orgId: r.org_id,
        orgName: r.org_name,
        totalRuns: Number(r.total_runs),
        totalEstimatedCostUsd: Number(r.total_cost),
        estimated: true as const,
      }));
    }
  );

  server.get(
    '/incidents',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { response: { 200: z.array(incidentSchema) } },
    },
    async (request) => {
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query('select * from incidents order by created_at desc limit 200');
      });
      return rows.map(mapIncident);
    }
  );

  server.post(
    '/incidents',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { body: incidentCreateSchema, response: { 201: incidentSchema } },
    },
    async (request, reply) => {
      const id = randomUUID();
      const { title, description, severity, orgId } = request.body;
      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        const inserted = await tx.query(
          `insert into incidents (id, org_id, title, description, severity, created_by)
           values ($1, $2, $3, $4, $5, $6) returning *`,
          [id, orgId ?? null, title, description ?? null, severity ?? 'low', request.userId]
        );
        // API-10: mismo cierre que jobs/retry -- se audita también un
        // incidente sin organización (plataforma-wide).
        await recordAudit(tx, {
          orgId: orgId ?? null,
          actorId: request.userId!,
          action: 'admin.incident.create',
          entity: 'incidents',
          entityId: id,
          after: { title, severity },
          requestId: request.id, correlationId: request.correlationId,
        });
        return inserted.rows[0];
      });
      reply.code(201);
      return mapIncident(row);
    }
  );

  // Ronda 4: `/incidents/:id/resolve` no lleva cuerpo -- mismo tratamiento
  // que `/jobs/:id/retry` arriba. `/incidents` (crear) NO se toca: sigue
  // exigiendo cuerpo real (`incidentCreateSchema`), fuera de este scope.
  await withOptionalEmptyJsonBody(server, (scoped) => {
    scoped.withTypeProvider<ZodTypeProvider>().post(
      '/incidents/:id/resolve',
      {
        preHandler: [app.authenticate, app.requireSuperadmin],
        schema: {
          description: 'Sin cuerpo (acepta Content-Type: application/json con cuerpo vacío).',
          params: z.object({ id: z.string().uuid() }),
          response: { 200: incidentSchema },
        },
      },
      async (request) => {
        const row = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
          const before = await tx.query<{ status: string; org_id: string | null }>('select status, org_id from incidents where id = $1', [
            request.params.id,
          ]);
          if (before.rows.length === 0) return null;
          if (before.rows[0].status === 'resolved') throw new ConflictError('El incidente ya está resuelto');
          const updated = await tx.query(
            "update incidents set status = 'resolved', resolved_at = now() where id = $1 returning *",
            [request.params.id]
          );
          // API-10: mismo cierre -- se audita también un incidente sin organización.
          await recordAudit(tx, {
            orgId: before.rows[0].org_id,
            actorId: request.userId!,
            action: 'admin.incident.resolve',
            entity: 'incidents',
            entityId: request.params.id,
            requestId: request.id, correlationId: request.correlationId,
          });
          return updated.rows[0];
        });
        if (!row) throw new NotFoundError('Incidente no encontrado');
        return mapIncident(row);
      }
    );
  });

  server.get(
    '/approvals',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { response: { 200: z.array(pendingApprovalSchema) } },
    },
    async (request) => {
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<{
          id: string;
          org_id: string;
          org_name: string;
          tool_name: string;
          agent_run_id: string;
          created_at: string;
        }>(
          `select tc.id, tc.org_id, o.name as org_name, tc.tool_name, tc.agent_run_id, tc.created_at
           from tool_calls tc
           join organizations o on o.id = tc.org_id
           where tc.authorization_status = 'pending'
           order by tc.created_at asc`
        );
      });
      return rows.map((r) => ({
        id: r.id,
        orgId: r.org_id,
        orgName: r.org_name,
        toolName: r.tool_name,
        agentRunId: r.agent_run_id,
        createdAt: r.created_at,
      }));
    }
  );

  // ---------------------------------------------------------------------
  // Ronda 4: bitácora de auditoría de PLATAFORMA (todas las organizaciones,
  // solo superadmin). Contraparte de `GET /audit-log` (una sola
  // organización, `modules/audit/routes.ts`) -- reutiliza sus mismos
  // esquemas/mapeo de fila para no duplicar la forma de la respuesta.
  // `org_id IS NULL` es válido aquí (eventos de plataforma, API-10) y NUNCA
  // lo es en la variante por organización.
  // ---------------------------------------------------------------------
  server.get(
    '/audit-log',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: {
        description: 'Bitácora de auditoría de TODAS las organizaciones (superadmin de plataforma).',
        querystring: adminAuditLogListQuerySchema,
        response: { 200: auditLogListResponseSchema },
      },
    },
    async (request) => {
      const { entity, actorId, orgId, correlationId, cursor, limit } = request.query;
      const createdFrom = parseDateFilter(request.query.createdFrom, 'createdFrom');
      const createdTo = parseDateFilter(request.query.createdTo, 'createdTo');
      const pageSize = parsePageSize(limit);
      const decoded = cursor ? decodeCursor(cursor) : null;

      const conditions: string[] = ['1 = 1'];
      const params: unknown[] = [];
      if (orgId) {
        params.push(orgId);
        conditions.push(`org_id = $${params.length}`);
      }
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
      if (decoded) {
        params.push(decoded.sortKey, decoded.id);
        conditions.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(pageSize + 1);

      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        // Sin `app.current_org_id`: `is_superadmin()` ya bypassea el filtro
        // de organización de la política RLS de `audit_log` por completo
        // (ver `app.apply_org_rls`/`sel_audit_log`, 0007/0008) -- este
        // superadmin ve filas de CUALQUIER organización, a propósito.
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

  // ---------------------------------------------------------------------
  // Ronda 4: aprobación CROSS-ORG de `tool_calls` por superadmin.
  // `GET /admin/approvals` (arriba) ya lista pendientes de TODAS las
  // organizaciones, pero apps/web (README, "Endpoints... gaps") señaló que
  // aprobar/denegar de verdad exigía `X-Org-Id` + rol owner/admin de ESA
  // organización -- un superadmin no necesariamente lo es, así que la
  // pantalla de back office quedaba de solo lectura. Estas rutas gatean
  // por `app.requireSuperadmin` (NUNCA por membresía), sin `X-Org-Id`: la
  // organización afectada se resuelve de la propia fila de `tool_calls`
  // (`org_id`), nunca de un header. El `UPDATE` atómico funciona cross-org
  // porque `is_superadmin()` bypassea el filtro `org_id = current_org_id()`
  // de la política RLS de `tool_calls` (mismo mecanismo que el `SELECT` de
  // arriba) -- ninguna fila de otra organización queda inaccesible para un
  // superadmin. `audit_log` registra al actor superadmin real y la
  // organización AFECTADA (nunca `org_id: null`, a diferencia de jobs/
  // incidentes de plataforma: una `tool_call` siempre pertenece a una
  // organización).
  //
  // R5-11 (docs/auditoria-2/api-r5-09-10-reverificacion.md): esta
  // aprobación cross-org exige ADEMÁS verificación en dos pasos (TOTP)
  // reciente, con `purpose: 'admin.action'` -- un superadmin sin 2FA
  // enrolado recibe el mismo 403 con instrucción que cualquier otro
  // consumidor de `requireStepUp` (ver lib/step-up.ts). Como esta ruta NO
  // lleva `X-Org-Id` (la organización afectada se resuelve de la propia
  // fila), el `orgId` que `requireStepUp` exige para el emparejamiento se
  // obtiene de un SELECT previo sobre la MISMA fila que luego se muta: el
  // superadmin debe pedir su `stepUpToken` (`X-Org-Id`/`purpose:
  // 'admin.action'`) atado a la organización DUEÑA de la tool_call concreta
  // que va a resolver -- una sesión de step-up no sirve para aprobar/denegar
  // una tool_call de otra organización. Si la tool_call no existe, se
  // responde 404 sin exigir step-up (nada que autorizar todavía) y la
  // sesión de step-up del superadmin queda sin consumir.
  // ---------------------------------------------------------------------
  await withOptionalEmptyJsonBody(server, (scoped) => {
    const s = scoped.withTypeProvider<ZodTypeProvider>();

    s.post(
      '/tool-calls/:id/approve',
      {
        preHandler: [app.authenticate, app.requireSuperadmin],
        config: {
          rateLimit: {
            hook: 'preHandler',
            max: app.rateLimitSettings.sensitiveAction.max,
            timeWindow: app.rateLimitSettings.sensitiveAction.timeWindow,
            keyGenerator: (req: any) => `admin-tool-call-approve:${req.userId ?? 'anon'}`,
          },
        },
        schema: {
          description: 'Sin cuerpo. Superadmin, cross-org (sin X-Org-Id). 409 si la tool_call ya fue resuelta.',
          params: z.object({ id: z.string().uuid() }),
          response: { 200: toolCallSchema },
        },
      },
      async (request) => {
        const userId = request.userId!;
        const row = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

          // R5-11: la organización afectada se resuelve de la propia fila
          // (esta ruta nunca lleva X-Org-Id) -- se necesita ANTES de exigir
          // step-up, para comprobar que la sesión presentada está atada a
          // ESA organización concreta. Si la fila no existe, 404 sin exigir
          // step-up (ver comentario arriba del bloque).
          const target = await tx.query<{ org_id: string }>('select org_id from tool_calls where id = $1', [request.params.id]);
          if (target.rows.length === 0) {
            return { kind: 'not_found' as const };
          }
          const affectedOrgId = target.rows[0].org_id;
          await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId: affectedOrgId, purpose: 'admin.action' });

          // API-09: mismo cierre atómico que `agents/routes.ts` (check +
          // mutación en la MISMA sentencia) -- ver comentario ahí.
          const updated = await tx.query(
            `update tool_calls set authorization_status = 'approved', approved_by = $1, approved_at = now()
             where id = $2 and authorization_status = 'pending' returning *`,
            [userId, request.params.id]
          );
          if (updated.rows.length === 0) {
            return { kind: 'not_pending' as const };
          }
          const toolCall = updated.rows[0] as Record<string, unknown>;
          await recordAudit(tx, {
            orgId: toolCall.org_id as string,
            actorId: userId,
            action: 'admin.tool_call.approve',
            entity: 'tool_calls',
            entityId: request.params.id,
            after: { authorizationStatus: 'approved', approvedBySuperadmin: true },
            requestId: request.id, correlationId: request.correlationId,
          });
          return { kind: 'ok' as const, row: toolCall };
        });
        if (row.kind === 'not_found') throw new NotFoundError('tool_call no encontrada');
        if (row.kind === 'not_pending') throw new ConflictError('La tool_call ya fue resuelta (no está pendiente)');
        return mapToolCall(row.row);
      }
    );

    s.post(
      '/tool-calls/:id/deny',
      {
        preHandler: [app.authenticate, app.requireSuperadmin],
        config: {
          rateLimit: {
            hook: 'preHandler',
            max: app.rateLimitSettings.sensitiveAction.max,
            timeWindow: app.rateLimitSettings.sensitiveAction.timeWindow,
            keyGenerator: (req: any) => `admin-tool-call-deny:${req.userId ?? 'anon'}`,
          },
        },
        schema: {
          description: 'Sin cuerpo. Superadmin, cross-org (sin X-Org-Id). 409 si la tool_call ya fue resuelta.',
          params: z.object({ id: z.string().uuid() }),
          response: { 200: toolCallSchema },
        },
      },
      async (request) => {
        const userId = request.userId!;
        const row = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

          // R5-11: mismo step-up cross-org que approve() -- ver comentario ahí.
          const target = await tx.query<{ org_id: string }>('select org_id from tool_calls where id = $1', [request.params.id]);
          if (target.rows.length === 0) {
            return { kind: 'not_found' as const };
          }
          const affectedOrgId = target.rows[0].org_id;
          await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId: affectedOrgId, purpose: 'admin.action' });

          const updated = await tx.query(
            `update tool_calls set authorization_status = 'denied', approved_by = $1, approved_at = now()
             where id = $2 and authorization_status = 'pending' returning *`,
            [userId, request.params.id]
          );
          if (updated.rows.length === 0) {
            return { kind: 'not_pending' as const };
          }
          const toolCall = updated.rows[0] as Record<string, unknown>;
          await recordAudit(tx, {
            orgId: toolCall.org_id as string,
            actorId: userId,
            action: 'admin.tool_call.deny',
            entity: 'tool_calls',
            entityId: request.params.id,
            after: { authorizationStatus: 'denied', deniedBySuperadmin: true },
            requestId: request.id, correlationId: request.correlationId,
          });
          return { kind: 'ok' as const, row: toolCall };
        });
        if (row.kind === 'not_found') throw new NotFoundError('tool_call no encontrada');
        if (row.kind === 'not_pending') throw new ConflictError('La tool_call ya fue resuelta (no está pendiente)');
        return mapToolCall(row.row);
      }
    );
  });

  // ---------------------------------------------------------------------
  // calendar_holidays (E11, REQ-050/056): calendario OFICIAL de días
  // inhábiles federales. Tabla de PLATAFORMA (sin org_id, igual que
  // `source_runs`, ver 0055_e11_post_award_details_and_calendar.sql):
  // lectura abierta a cualquier usuario autenticado (dato público, lo
  // consume el motor de plazos de CUALQUIER organización), escritura
  // reservada a superadmin.
  // ---------------------------------------------------------------------
  server.get(
    '/calendar-holidays',
    {
      preHandler: [app.authenticate],
      schema: {
        description: 'Calendario oficial de días inhábiles cargado por un administrador (puede estar vacío -- ver calendarNote en /expediente/tenders/:id/post-award).',
        querystring: calendarHolidayListQuerySchema,
        response: { 200: z.array(calendarHolidaySchema) },
      },
    },
    async (request) => {
      const conditions: string[] = ['1 = 1'];
      const params: unknown[] = [];
      if (request.query.jurisdiction) {
        params.push(request.query.jurisdiction);
        conditions.push(`jurisdiction = $${params.length}`);
      }
      if (request.query.year) {
        params.push(Number(request.query.year));
        conditions.push(`year = $${params.length}`);
      }
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<Record<string, unknown>>(
          `select * from calendar_holidays where ${conditions.join(' and ')} order by holiday_date asc`,
          params
        );
      });
      return rows.map(mapCalendarHoliday);
    }
  );

  server.post(
    '/calendar-holidays',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: {
        description: 'Carga un día inhábil oficial (requiere fuente verificable -- sourceUrl + sourceConsultedOn, nunca una fecha "de memoria").',
        body: calendarHolidayCreateSchema,
        response: { 201: calendarHolidaySchema },
      },
    },
    async (request, reply) => {
      const userId = request.userId!;
      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
        const id = randomUUID();
        const inserted = await tx.query<Record<string, unknown>>(
          `insert into calendar_holidays (id, jurisdiction, year, holiday_date, label, source_url, source_consulted_on, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (jurisdiction, holiday_date) do update set
             year = excluded.year, label = excluded.label, source_url = excluded.source_url,
             source_consulted_on = excluded.source_consulted_on, created_by = excluded.created_by
           returning *`,
          [id, request.body.jurisdiction, request.body.year, request.body.date, request.body.label, request.body.sourceUrl, request.body.sourceConsultedOn, userId]
        );
        await recordAudit(tx, {
          orgId: null,
          actorId: userId,
          action: 'calendar_holiday.upsert',
          entity: 'calendar_holidays',
          entityId: String(inserted.rows[0].id),
          after: { jurisdiction: request.body.jurisdiction, date: request.body.date, label: request.body.label, sourceUrl: request.body.sourceUrl },
          requestId: request.id,
          correlationId: request.correlationId,
        });
        return inserted.rows[0];
      });
      reply.code(201);
      return mapCalendarHoliday(row as Record<string, unknown>);
    }
  );

  // -------------------------------------------------------------------------
  // REQ-026/REQ-111/REQ-112: KYC negativo (lista 69-B) + fingerprint de
  // interpósita persona -- las tablas crudas (packages/db/migrations/
  // 0099/0100) son de solo superadmin/worker_role; estas 3 rutas son la
  // única forma en que un humano puede ver el resultado del job nocturno
  // de `apps/worker` (mismo criterio que `/connectors/freshness` para
  // fuentes de descubrimiento).
  // -------------------------------------------------------------------------
  server.get(
    '/kyc/freshness',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { response: { 200: adminKycListFreshnessSchema } },
    },
    async (request) => {
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<{ id: string; fetched_at: string; list_as_of_date: string | null; record_count: number }>(
          'select id, fetched_at, list_as_of_date, record_count from sanctions_69b_snapshots order by fetched_at desc limit 1'
        );
      });
      const row = rows[0];
      const fetchedAt = row ? new Date(row.fetched_at) : null;
      const ageSeconds = fetchedAt ? Math.floor((Date.now() - fetchedAt.getTime()) / 1000) : null;
      return {
        snapshotId: row?.id ?? null,
        fetchedAt: row?.fetched_at ?? null,
        listAsOfDate: row?.list_as_of_date ?? null,
        recordCount: row ? Number(row.record_count) : null,
        ageSeconds,
        // REQ-026 literal ("alerta si listas >48h desactualizadas"): nunca
        // hubo corrida (fetchedAt null) también cuenta como obsoleta.
        isStale: isNegativeListStale(fetchedAt),
      };
    }
  );

  server.get(
    '/kyc/tenants',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { response: { 200: z.array(adminKycTenantStatusSchema) } },
    },
    async (request) => {
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        // Solo tenants con algo que revisar (flagged/suspended) -- una
        // organización 'clear' no es una alerta de compliance.
        return tx.query<{ org_id: string; org_name: string; verdict: string; reason: string | null; updated_at: string }>(
          `select s.org_id, o.name as org_name, s.verdict, s.reason, s.updated_at
           from tenant_kyc_status s
           join organizations o on o.id = s.org_id
           where s.verdict <> 'clear'
           order by s.updated_at desc`
        );
      });
      return rows.map((r) => ({ orgId: r.org_id, orgName: r.org_name, verdict: r.verdict as 'flagged' | 'suspended', reason: r.reason, updatedAt: r.updated_at }));
    }
  );

  server.get(
    '/kyc/fingerprint-matches',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { response: { 200: z.array(adminKycFingerprintMatchSchema) } },
    },
    async (request) => {
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query<{
          org_id_a: string;
          org_name_a: string;
          org_id_b: string;
          org_name_b: string;
          score: string;
          matched_fields: Array<{ field: string; value: string }>;
          detected_at: string;
          status: string;
        }>(
          `select m.org_id_a, oa.name as org_name_a, m.org_id_b, ob.name as org_name_b, m.score, m.matched_fields, m.detected_at, m.status
           from entity_fingerprint_matches m
           join organizations oa on oa.id = m.org_id_a
           join organizations ob on ob.id = m.org_id_b
           where m.status = 'open'
           order by m.score desc`
        );
      });
      return rows.map((r) => ({
        orgIdA: r.org_id_a,
        orgNameA: r.org_name_a,
        orgIdB: r.org_id_b,
        orgNameB: r.org_name_b,
        score: Number(r.score),
        matchedFields: r.matched_fields,
        detectedAt: r.detected_at,
        status: r.status,
      }));
    }
  );
}

function mapCalendarHoliday(r: Record<string, unknown>): {
  id: string;
  jurisdiction: string;
  year: number;
  date: string | Date;
  label: string;
  sourceUrl: string;
  sourceConsultedOn: string | Date;
  createdAt: string | Date;
} {
  return {
    id: r.id as string,
    jurisdiction: r.jurisdiction as string,
    year: r.year as number,
    date: r.holiday_date as string | Date,
    label: r.label as string,
    sourceUrl: r.source_url as string,
    sourceConsultedOn: r.source_consulted_on as string | Date,
    createdAt: r.created_at as string | Date,
  };
}

function mapIncident(r: any) {
  return {
    id: r.id,
    orgId: r.org_id,
    title: r.title,
    description: r.description,
    severity: r.severity,
    status: r.status,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}
