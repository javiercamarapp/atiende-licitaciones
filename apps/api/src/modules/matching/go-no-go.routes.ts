import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DECISION_ROLES, type OrgRole } from '@atiende/db';
import { NotFoundError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { requireOrgRole } from '../../lib/authorize.js';
import { goNoGoDecisionCreateSchema, goNoGoDecisionSchema } from './go-no-go.schemas.js';

/**
 * Roles que pueden decidir Go/No-Go (E5): ronda 2 pide explícitamente
 * "rol ≥ reviewer/admin; writer NO puede decidir" -- se amplía
 * `DECISION_ROLES` ({owner,admin,analyst} en @atiende/db) con `reviewer`
 * para esta decisión específica (ver packages/db/migrations/
 * 0024_go_no_go_reviewer.sql, que amplía la política RLS en el mismo
 * sentido: la aplicación y la base de datos coinciden).
 */
const GO_NO_GO_ROLES: OrgRole[] = [...DECISION_ROLES, 'reviewer'];

function mapRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    tenderId: r.tender_id,
    decision: r.decision,
    reasons: r.reasons ?? [],
    decidedBy: r.decided_by,
    decidedAt: r.decided_at,
  };
}

export async function goNoGoRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/:tenderId/go-no-go',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: z.array(goNoGoDecisionSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const { rows } = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [request.userId]);
        return tx.query(
          'select * from go_no_go_decisions where org_id = $1 and tender_id = $2 order by decided_at desc',
          [orgId, request.params.tenderId]
        );
      });
      return rows.map((r) => mapRow(r as Record<string, unknown>));
    }
  );

  server.post(
    '/:tenderId/go-no-go',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: {
        params: z.object({ tenderId: z.string().uuid() }),
        body: goNoGoDecisionCreateSchema,
        response: { 201: goNoGoDecisionSchema },
      },
    },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      // Enforcement de aplicación, ADEMÁS de RLS (0024): writer/viewer nunca
      // deciden go/no-go, sin importar el estado de la base.
      requireOrgRole(request, GO_NO_GO_ROLES, 'Se requiere rol reviewer/analyst/admin/owner para decidir go/no-go');

      const { decision, reasons } = request.body;
      const id = randomUUID();

      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        const tenderRes = await tx.query('select id from tenders where id = $1 and org_id = $2', [
          request.params.tenderId,
          orgId,
        ]);
        if (tenderRes.rows.length === 0) return null;

        const inserted = await tx.query(
          `insert into go_no_go_decisions (id, org_id, tender_id, decision, reasons, decided_by)
           values ($1, $2, $3, $4, $5, $6) returning *`,
          [id, orgId, request.params.tenderId, decision, reasons, userId]
        );
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'go_no_go.decide',
          entity: 'go_no_go_decisions',
          entityId: id,
          after: { decision, reasons },
          requestId: request.id, correlationId: request.correlationId,
        });
        return inserted.rows[0];
      });

      if (!row) throw new NotFoundError('Convocatoria no encontrada');
      reply.code(201);
      return mapRow(row as Record<string, unknown>);
    }
  );
}
