import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { MEMBERSHIP_ADMIN_ROLES } from '@atiende/db';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireOrgRole } from '../../lib/authorize.js';
import { requireStepUp } from '../../lib/step-up.js';
import { withOptionalEmptyJsonBody } from '../../lib/optional-empty-body.js';
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

  // Ronda 4: `approve`/`deny` no llevan cuerpo -- se registran dentro de un
  // scope que tolera `Content-Type: application/json` con cuerpo vacío
  // (ver `lib/optional-empty-body.ts`, item 5 de docs/logs/api-ronda4.log)
  // y con un límite de tasa propio, aplicado DESPUÉS de `app.requireOrg`
  // (`hook: 'preHandler'`), aislado por organización+actor -- una
  // organización con mucho volumen de aprobaciones no consume el
  // presupuesto de otra (ver `lib/rate-limit-settings.ts`).
  await withOptionalEmptyJsonBody(server, (scoped) => {
    const s = scoped.withTypeProvider<ZodTypeProvider>();

    s.post(
      '/tool-calls/:id/approve',
      {
        preHandler: [app.authenticate, app.requireOrg],
        config: {
          rateLimit: {
            hook: 'preHandler',
            max: app.rateLimitSettings.sensitiveAction.max,
            timeWindow: app.rateLimitSettings.sensitiveAction.timeWindow,
            keyGenerator: (req: any) => `tool-call-approve:${req.orgId ?? 'no-org'}:${req.userId ?? 'anon'}`,
          },
        },
        schema: {
          description: 'Sin cuerpo (acepta Content-Type: application/json con cuerpo vacío). Solo owner/admin; 409 si la tool_call ya fue resuelta.',
          params: z.object({ id: z.string().uuid() }),
          response: { 200: toolCallSchema },
        },
      },
      async (request) => {
        const orgId = request.orgId!;
        const userId = request.userId!;
        // Aprobar una tool_call pendiente es una decisión de riesgo (puede ser
        // `external`/`irreversible` en packages/agents): se reserva a
        // owner/admin, igual que el resto de aprobaciones sensibles de esta
        // ronda (tarifas, roles).
        requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden aprobar una tool_call pendiente');

        const row = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

          // R5-11 (docs/auditoria-2/api-r5-09-10-reverificacion.md): aprobar
          // una tool_call puede autorizar gasto/envío/uso de API en nombre
          // de la organización -- exige verificación en dos pasos (TOTP)
          // reciente, distinta del rol que aprueba, igual que
          // company/rates y expediente/approval (ver lib/step-up.ts). Sin
          // 2FA enrolado o sin X-Step-Up vigente, 403 explícito ANTES de
          // tocar la fila; el `stepUpToken` presentado debe estar atado
          // EXACTAMENTE a esta organización/acción y se consume de un solo uso.
          await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId, purpose: 'tool_call.approval' });

          // API-09 (docs/auditoria-1/db-api-reverificacion.md): el check
          // (`pending`) y la mutación deben ser LA MISMA sentencia atómica --
          // un SELECT previo seguido de un UPDATE sin repetir la condición en
          // su propio WHERE deja una ventana TOCTOU real bajo un pool de
          // conexiones físicas concurrentes (no reproducible bajo PGlite,
          // conexión física única, pero sí bajo `pg.Pool` de producción).
          const updated = await tx.query(
            `update tool_calls set authorization_status = 'approved', approved_by = $1, approved_at = now()
             where id = $2 and org_id = $3 and authorization_status = 'pending' returning *`,
            [userId, request.params.id, orgId]
          );
          if (updated.rows.length === 0) {
            const existing = await tx.query('select id from tool_calls where id = $1 and org_id = $2', [request.params.id, orgId]);
            return existing.rows.length === 0 ? { kind: 'not_found' as const } : { kind: 'not_pending' as const };
          }
          await recordAudit(tx, {
            orgId,
            actorId: userId,
            action: 'tool_call.approve',
            entity: 'tool_calls',
            entityId: request.params.id,
            requestId: request.id, correlationId: request.correlationId,
          });
          return { kind: 'ok' as const, row: updated.rows[0] };
        });

        if (row.kind === 'not_found') throw new NotFoundError('tool_call no encontrada');
        if (row.kind === 'not_pending') throw new ConflictError('La tool_call ya fue resuelta (no está pendiente)');
        return mapToolCall(row.row);
      }
    );

    s.post(
      '/tool-calls/:id/deny',
      {
        preHandler: [app.authenticate, app.requireOrg],
        config: {
          rateLimit: {
            hook: 'preHandler',
            max: app.rateLimitSettings.sensitiveAction.max,
            timeWindow: app.rateLimitSettings.sensitiveAction.timeWindow,
            keyGenerator: (req: any) => `tool-call-deny:${req.orgId ?? 'no-org'}:${req.userId ?? 'anon'}`,
          },
        },
        schema: {
          description: 'Sin cuerpo (acepta Content-Type: application/json con cuerpo vacío). Solo owner/admin; 409 si la tool_call ya fue resuelta.',
          params: z.object({ id: z.string().uuid() }),
          response: { 200: toolCallSchema },
        },
      },
      async (request) => {
        const orgId = request.orgId!;
        const userId = request.userId!;
        requireOrgRole(request, MEMBERSHIP_ADMIN_ROLES, 'Solo owner/admin pueden denegar una tool_call pendiente');

        const row = await app.db.transaction(async (tx) => {
          await tx.query('set local role app_role');
          await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
          await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

          // R5-11: mismo step-up que approve() -- ver comentario ahí.
          await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId, purpose: 'tool_call.approval' });

          // API-09: mismo cierre atómico que approve() -- ver comentario ahí.
          const updated = await tx.query(
            `update tool_calls set authorization_status = 'denied', approved_by = $1, approved_at = now()
             where id = $2 and org_id = $3 and authorization_status = 'pending' returning *`,
            [userId, request.params.id, orgId]
          );
          if (updated.rows.length === 0) {
            const existing = await tx.query('select id from tool_calls where id = $1 and org_id = $2', [request.params.id, orgId]);
            return existing.rows.length === 0 ? { kind: 'not_found' as const } : { kind: 'not_pending' as const };
          }
          await recordAudit(tx, {
            orgId,
            actorId: userId,
            action: 'tool_call.deny',
            entity: 'tool_calls',
            entityId: request.params.id,
            requestId: request.id, correlationId: request.correlationId,
          });
          return { kind: 'ok' as const, row: updated.rows[0] };
        });

        if (row.kind === 'not_found') throw new NotFoundError('tool_call no encontrada');
        if (row.kind === 'not_pending') throw new ConflictError('La tool_call ya fue resuelta (no está pendiente)');
        return mapToolCall(row.row);
      }
    );
  });
}

export { mapToolCall };

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
