import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DbExecutor } from '@atiende/db';
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
 *
 * Exportado (además de usarse en la ruta HTTP de este archivo) para que
 * `apps/api/src/lib/whatsapp/resolve-decision-actor.ts` (REQ-090: la MISMA
 * decisión, disparada desde un botón/lista de WhatsApp en vez de
 * `POST /tenders/:id/go-no-go`) aplique EXACTAMENTE la misma regla de
 * autorización -- nunca una copia que pudiera divergir.
 */
export const GO_NO_GO_ROLES: OrgRole[] = [...DECISION_ROLES, 'reviewer'];

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

export interface DecideGoNoGoParams {
  orgId: string;
  userId: string;
  tenderId: string;
  decision: 'go' | 'no_go';
  reasons: string[];
  requestId?: string | null;
  correlationId?: string | null;
  /** Origen de la decisión, para `audit_log.after` -- 'http' (la ruta de
   *  abajo) o 'whatsapp' (REQ-090, `modules/whatsapp/webhook.routes.ts`).
   *  Nunca cambia la regla de negocio, solo deja rastro de por dónde entró. */
  source?: 'http' | 'whatsapp';
}

export interface GoNoGoDecisionRow {
  id: string;
  tenderId: string;
  decision: 'go' | 'no_go';
  reasons: string[];
  decidedBy: string;
  decidedAt: string;
}

/**
 * Inserta una decisión Go/No-Go real y su auditoría, dentro de una
 * transacción que YA tiene `set local role app_role` y
 * `app.current_org_id`/`app.current_user_id` fijados por el llamador (mismo
 * contrato que `persistMatch`/`buildProfileAndEligibility` en
 * `modules/matching/routes.ts`) -- esta función nunca abre su propia
 * transacción ni decide el contexto de sesión, así que RLS (0024) protege
 * IGUAL sin importar si el llamador es la ruta HTTP o el webhook de
 * WhatsApp. Devuelve `null` si el tender no existe en esta organización
 * (nunca inserta una decisión "huérfana").
 */
export async function decideGoNoGo(tx: DbExecutor, params: DecideGoNoGoParams): Promise<GoNoGoDecisionRow | null> {
  const tenderRes = await tx.query('select id from tenders where id = $1 and org_id = $2', [params.tenderId, params.orgId]);
  if (tenderRes.rows.length === 0) return null;

  const id = randomUUID();
  const inserted = await tx.query(
    `insert into go_no_go_decisions (id, org_id, tender_id, decision, reasons, decided_by)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [id, params.orgId, params.tenderId, params.decision, params.reasons, params.userId]
  );
  await recordAudit(tx, {
    orgId: params.orgId,
    actorId: params.userId,
    action: 'go_no_go.decide',
    entity: 'go_no_go_decisions',
    entityId: id,
    after: { decision: params.decision, reasons: params.reasons, source: params.source ?? 'http' },
    requestId: params.requestId ?? null,
    correlationId: params.correlationId ?? null,
  });
  return mapRow(inserted.rows[0] as Record<string, unknown>);
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

      const row = await app.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
        await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);

        return decideGoNoGo(tx, {
          orgId,
          userId,
          tenderId: request.params.tenderId,
          decision,
          reasons,
          requestId: request.id,
          correlationId: request.correlationId,
          source: 'http',
        });
      });

      if (!row) throw new NotFoundError('Convocatoria no encontrada');
      reply.code(201);
      return row;
    }
  );
}
