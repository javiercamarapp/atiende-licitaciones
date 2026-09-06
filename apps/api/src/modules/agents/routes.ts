import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MEMBERSHIP_ADMIN_ROLES } from '@atiende/db';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireOrgRole } from '../../lib/authorize.js';
import { agentRunSchema, toolCallSchema, toolCallListQuerySchema } from './schemas.js';

/**
 * Endpoints de solo-lectura sobre `agent_runs`/`tool_calls` (persistidos vía
 * los adaptadores `PgRunStore`/`PgToolCallStore` de
 * apps/api/src/lib/agent-stores.pg.ts, que implementan las interfaces
 * `RunStore`/`ToolCallStore` de packages/agents) + aprobación humana de
 * `tool_calls` pendientes por rol. Cableado completo de `AgentRunner` con
 * proveedores LLM reales queda fuera de esta ronda (ver
 * packages/agents/README.md "Cómo lo consumirá apps/api" y "Pendientes");
 * esta ronda entrega la CAPA DE PERSISTENCIA y el flujo de aprobación
 * humana, que es lo que pedía el encargo.
 */
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/runs',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { response: { 200: z.array(agentRunSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query('select * from agent_runs where org_id = $1 order by created_at desc limit 100', [orgId]);
      });
      return rows.map((r: any) => ({
        id: r.id,
        agentName: r.agent_name,
        status: r.status,
        totalSteps: r.total_steps,
        completedSteps: r.completed_steps,
        correlationId: r.correlation_id,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
      }));
    }
  );

  server.get(
    '/tool-calls',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { querystring: toolCallListQuerySchema, response: { 200: z.array(toolCallSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { status } = request.query;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        if (status) {
          return tx.query(
            'select * from tool_calls where org_id = $1 and authorization_status = $2 order by created_at desc limit 100',
            [orgId, status]
          );
        }
        return tx.query('select * from tool_calls where org_id = $1 order by created_at desc limit 100', [orgId]);
      });
      return rows.map(mapToolCall);
    }
  );

  server.post(
    '/tool-calls/:id/approve',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ id: z.string().uuid() }), response: { 200: toolCallSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      // Aprobar una tool_call pendiente es una decisión de riesgo (puede ser
      // `external`/`irreversible` en packages/agents): se reserva a
      // owner/admin, igual que el resto de aprobaciones sensibles de esta
      // ronda (tarifas, roles). Re-autenticación no exigida en esta ronda
      // (documentado como pendiente), pero SÍ se registra quién aprobó
      // (approved_by/approved_at) y queda en audit_log.
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden aprobar una tool_call pendiente');

      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        const before = await tx.query<{ authorization_status: string }>(
          'select authorization_status from tool_calls where id = $1 and org_id = $2',
          [request.params.id, orgId]
        );
        if (before.rows.length === 0) return { kind: 'not_found' as const };
        if (before.rows[0].authorization_status !== 'pending') return { kind: 'not_pending' as const };

        const updated = await tx.query(
          `update tool_calls set authorization_status = 'approved', approved_by = $1, approved_at = now()
           where id = $2 and org_id = $3 returning *`,
          [userId, request.params.id, orgId]
        );
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'tool_call.approve',
          entity: 'tool_calls',
          entityId: request.params.id,
          requestId: request.id,
        });
        return { kind: 'ok' as const, row: updated.rows[0] };
      });

      if (row.kind === 'not_found') throw new NotFoundError('tool_call no encontrada');
      if (row.kind === 'not_pending') throw new ConflictError('La tool_call ya fue resuelta (no está pendiente)');
      return mapToolCall(row.row);
    }
  );

  server.post(
    '/tool-calls/:id/deny',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ id: z.string().uuid() }), response: { 200: toolCallSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden denegar una tool_call pendiente');

      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        const before = await tx.query<{ authorization_status: string }>(
          'select authorization_status from tool_calls where id = $1 and org_id = $2',
          [request.params.id, orgId]
        );
        if (before.rows.length === 0) return { kind: 'not_found' as const };
        if (before.rows[0].authorization_status !== 'pending') return { kind: 'not_pending' as const };

        const updated = await tx.query(
          `update tool_calls set authorization_status = 'denied', approved_by = $1, approved_at = now()
           where id = $2 and org_id = $3 returning *`,
          [userId, request.params.id, orgId]
        );
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'tool_call.deny',
          entity: 'tool_calls',
          entityId: request.params.id,
          requestId: request.id,
        });
        return { kind: 'ok' as const, row: updated.rows[0] };
      });

      if (row.kind === 'not_found') throw new NotFoundError('tool_call no encontrada');
      if (row.kind === 'not_pending') throw new ConflictError('La tool_call ya fue resuelta (no está pendiente)');
      return mapToolCall(row.row);
    }
  );
}

function mapToolCall(r: any) {
  return {
    id: r.id,
    agentRunId: r.agent_run_id,
    toolName: r.tool_name,
    authorizationStatus: r.authorization_status,
    status: r.status ?? null,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    createdAt: r.created_at,
  };
}
