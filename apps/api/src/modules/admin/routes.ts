import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import {
  adminOrgSchema,
  adminConnectorFreshnessSchema,
  adminJobSchema,
  adminCostByOrgSchema,
  incidentCreateSchema,
  incidentSchema,
  pendingApprovalSchema,
} from './schemas.js';

/**
 * Back office / superadmin (E10, REQ-170): organizaciones, conectores y su
 * frescura, jobs (listar/reintentar), costos de IA por organización,
 * incidentes y aprobaciones pendientes. Todas las rutas están gateadas por
 * `app.requireSuperadmin` (platform_admins, ver plugins/superadmin.plugin.ts)
 * -- NUNCA por membresía de organización: un superadmin ve TODAS las
 * organizaciones, no solo la suya. Cada mutación queda en `audit_log`
 * (con `org_id` de la organización afectada cuando aplica, o de una
 * organización "de sistema" cuando el evento es verdaderamente
 * plataforma-wide, para respetar el NOT NULL de `audit_log.org_id`).
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

  server.post(
    '/jobs/:id/retry',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { params: z.object({ id: z.string().uuid() }), response: { 200: adminJobSchema } },
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
        if (before.rows[0].org_id) {
          await recordAudit(tx, {
            orgId: before.rows[0].org_id,
            actorId: request.userId!,
            action: 'admin.job.retry',
            entity: 'jobs',
            entityId: request.params.id,
            before: { status: before.rows[0].status },
            after: { status: 'queued' },
            requestId: request.id,
          });
        }
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
        if (orgId) {
          await recordAudit(tx, {
            orgId,
            actorId: request.userId!,
            action: 'admin.incident.create',
            entity: 'incidents',
            entityId: id,
            after: { title, severity },
            requestId: request.id,
          });
        }
        return inserted.rows[0];
      });
      reply.code(201);
      return mapIncident(row);
    }
  );

  server.post(
    '/incidents/:id/resolve',
    {
      preHandler: [app.authenticate, app.requireSuperadmin],
      schema: { params: z.object({ id: z.string().uuid() }), response: { 200: incidentSchema } },
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
        if (before.rows[0].org_id) {
          await recordAudit(tx, {
            orgId: before.rows[0].org_id,
            actorId: request.userId!,
            action: 'admin.incident.resolve',
            entity: 'incidents',
            entityId: request.params.id,
            requestId: request.id,
          });
        }
        return updated.rows[0];
      });
      if (!row) throw new NotFoundError('Incidente no encontrado');
      return mapIncident(row);
    }
  );

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
