/**
 * REQ-051 — máquina de estados de COBRANZA para `post_award_followups` de
 * `kind='facturacion'`/`kind='pago'` (E11, seguimiento post-adjudicación).
 * REUSA el modelo ya existente (`cfdiReference`/`acceptanceDate`, migración
 * 0055) en vez de duplicarlo -- ver `post-award.routes.ts`.
 *
 * El catálogo de transiciones válidas vive en
 * `lib/expediente/collection-lifecycle.ts` (mismo precedente que
 * `contract-lifecycle.ts`, REQ-051 del contrato completo); una transición
 * inválida responde 409 con el detalle de los estados permitidos, nunca
 * aplica un cambio parcial. El historial (`collection_status_history`) es
 * inmutable (solo INSERT/SELECT, RLS sin políticas de UPDATE/DELETE).
 *
 * Regla dura (transversal, ver docs/BLOQUEOS.md): marcar una cobranza como
 * "pagada" exige verificación en dos pasos (2FA/step-up) reciente -- es
 * dinero real, nunca se infiere ni se marca automáticamente. Ninguna ruta
 * de este archivo envía nada a ningún tercero: las alertas se encolan como
 * `jobs` inertes (mismo patrón que `contract_state_alert`/
 * `post_award_followup_reminder`).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import type { DbExecutor } from '@atiende/db';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { requireStepUp } from '../../lib/step-up.js';
import { ConflictError, ValidationAppError } from '../../lib/errors.js';
import { withTx, requireTender } from '../../lib/expediente/context.js';
import {
  COLLECTION_ALERT_STATES,
  COLLECTION_STEP_UP_TRANSITIONS,
  checkCollectionTransition,
  isCollectionStatus,
  type CollectionStatus,
} from '../../lib/expediente/collection-lifecycle.js';
import { requireFollowup, mapFollowupRow } from './post-award.routes.js';
import { collectionTransitionRequestSchema, collectionStatusHistoryItemSchema, followupSchema } from './schemas.js';

function mapCollectionHistoryRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    followupId: r.followup_id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    reason: r.reason,
    actorId: r.actor_id,
    evidenceRef: r.evidence_ref,
    createdAt: r.created_at,
  };
}

/**
 * Exige que el `post_award_followup` resuelto tenga un ciclo de cobranza
 * (`kind='facturacion'`/`kind='pago'`, `collection_status` no nulo -- ver
 * migración 0094 y el alta en `post-award.routes.ts`, que siempre lo
 * inicializa para esos dos `kind`). Cualquier otro `kind` nunca tuvo un
 * ciclo de cobranza que transicionar/consultar.
 */
function requireCollectionStatus(followup: Record<string, unknown>): CollectionStatus {
  const status = followup.collection_status as string | null;
  if (!status || !isCollectionStatus(status)) {
    throw new ValidationAppError({
      followupId: `El seguimiento "${followup.id}" (kind="${followup.kind}") no tiene un ciclo de cobranza -- la máquina de estados de cobranza solo aplica a kind="facturacion"/kind="pago".`,
    });
  }
  return status;
}

/**
 * `UPDATE` condicionado sobre el `collection_status` leído (mismo patrón
 * que `updateContractStatusConditioned` en `contract.routes.ts`, R6-04/
 * R6-10): dos transiciones concurrentes que parten del MISMO estado nunca
 * pueden tener éxito ambas. Exportada para poder probarse de forma
 * determinista con un `fromStatus` deliberadamente obsoleto.
 */
export async function updateCollectionStatusConditioned(
  tx: DbExecutor,
  params: { orgId: string; followupId: string; fromStatus: string; toStatus: string }
): Promise<Record<string, unknown>> {
  const { orgId, followupId, fromStatus, toStatus } = params;
  const updated = await tx.query<Record<string, unknown>>(
    'update post_award_followups set collection_status = $1 where id = $2 and org_id = $3 and collection_status = $4 returning *',
    [toStatus, followupId, orgId, fromStatus]
  );
  if (updated.rows.length === 0) {
    const current = await tx.query<{ collection_status: string | null }>('select collection_status from post_award_followups where id = $1 and org_id = $2', [followupId, orgId]);
    const currentStatus = current.rows[0]?.collection_status ?? fromStatus;
    throw new ConflictError(
      `El estado de cobranza cambió mientras se procesaba esta transición (de "${fromStatus}" ya pasó a "${currentStatus}" por otra solicitud). Reintente la transición partiendo del estado actual.`,
      { fromStatus, toStatus, currentStatus }
    );
  }
  return updated.rows[0];
}

export async function expedienteCollectionRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/tenders/:tenderId/post-award/:followupId/collection-history',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid(), followupId: z.string().uuid() }), response: { 200: z.array(collectionStatusHistoryItemSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const followup = await requireFollowup(tx, orgId, request.params.tenderId, request.params.followupId);
        requireCollectionStatus(followup);
        return (
          await tx.query<Record<string, unknown>>(
            'select * from collection_status_history where org_id = $1 and followup_id = $2 order by created_at asc',
            [orgId, request.params.followupId]
          )
        ).rows;
      });
      return rows.map(mapCollectionHistoryRow);
    }
  );

  server.post(
    '/tenders/:tenderId/post-award/:followupId/collection-transition',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: {
        params: z.object({ tenderId: z.string().uuid(), followupId: z.string().uuid() }),
        body: collectionTransitionRequestSchema,
        response: { 200: followupSchema },
      },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para transicionar el estado de cobranza de un seguimiento');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const followup = await requireFollowup(tx, orgId, request.params.tenderId, request.params.followupId);
        const fromStatus = requireCollectionStatus(followup);
        const toStatus = request.body.toStatus;

        const check = checkCollectionTransition(fromStatus, toStatus);
        if (!check.valid) {
          throw new ConflictError(
            `Transición de cobranza inválida: "${fromStatus}" -> "${toStatus}". Estados permitidos desde "${fromStatus}": ${check.allowedNextStates.length > 0 ? check.allowedNextStates.join(', ') : '(ninguno; estado terminal)'}.`,
            { fromStatus, toStatus, allowedNextStates: check.allowedNextStates }
          );
        }

        // Regla dura (tarea despachada/docs/BLOQUEOS.md): marcar "pagada" es
        // dinero real confirmado -- nunca se infiere. Exige 2FA reciente,
        // verificado DESPUÉS de validar la transición en el grafo (para no
        // gastar un step-up de un solo uso en una transición que de todos
        // modos iba a rechazarse con 409), pero ANTES de escribir nada.
        if (COLLECTION_STEP_UP_TRANSITIONS.includes(toStatus)) {
          await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId, purpose: 'expediente.collection_transition' });
        }

        const updated = await updateCollectionStatusConditioned(tx, { orgId, followupId: request.params.followupId, fromStatus, toStatus });

        await tx.query(
          `insert into collection_status_history (id, org_id, followup_id, from_status, to_status, reason, actor_id, evidence_ref, correlation_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), orgId, request.params.followupId, fromStatus, toStatus, request.body.reason, userId, request.body.evidenceRef ?? null, request.correlationId ?? null]
        );

        // REQ-051/REQ-056: alerta encolada (sin envío externo, ver
        // docstring del módulo) cuando la cobranza entra a un estado que
        // exige atención -- reusa el mismo mecanismo genérico de `jobs` que
        // `contract_state_alert`/`post_award_followup_reminder`, y además
        // el propio `alertLevel` de `GET /post-award-alerts` ya recoge
        // estos estados sin duplicar el cálculo (ver `computeAlertLevel` en
        // `post-award.routes.ts`).
        if (COLLECTION_ALERT_STATES.includes(toStatus)) {
          await tx.query(
            `insert into jobs (id, org_id, kind, payload, status, next_run_at, correlation_id)
             values ($1, $2, 'collection_status_alert', $3::jsonb, 'queued', now(), $4)`,
            [
              randomUUID(),
              orgId,
              JSON.stringify({ tenderId: request.params.tenderId, followupId: request.params.followupId, fromStatus, toStatus, reason: request.body.reason }),
              request.correlationId ?? null,
            ]
          );
        }

        await recordAudit(tx, {
          orgId, actorId: userId, action: 'collection_status.transition', entity: 'post_award_followups', entityId: request.params.followupId,
          before: { collectionStatus: fromStatus }, after: { collectionStatus: toStatus, reason: request.body.reason },
          requestId: request.id, correlationId: request.correlationId,
        });

        return updated;
      });

      return mapFollowupRow(row);
    }
  );
}
