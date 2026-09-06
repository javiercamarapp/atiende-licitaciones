/**
 * REQ-053 — redactor de inconformidades. Genera un BORRADOR estructurado
 * (hechos/agravios/fundamentos con jurisdicción y fecha DOF/pruebas/plazo)
 * a partir del fallo y de los datos que el usuario captura. Este módulo
 * JAMÁS presenta nada ante ninguna autoridad: no hay ningún cliente HTTP
 * saliente en todo este archivo (mismo patrón verificable que
 * `submission.routes.ts`, ver `test/expediente-e2e-flow.test.ts`). El
 * plazo se calcula con el motor determinista de `business-days.ts`
 * (Art. 95 LAASSP, 6/10 días hábiles), nunca con un LLM.
 *
 * Cada generación crea una VERSIÓN nueva (fila nueva, nunca se edita el
 * contenido de una existente -- ver el trigger de inmutabilidad en la
 * migración 0068). "Marcar como revisado" (única transición de estado
 * posible) exige verificación en dos pasos reciente (2FA/step-up,
 * `purpose='expediente.inconformidad_review'`) y un rol de revisión
 * (reviewer/admin/owner) -- protege que un abogado humano, y no cualquier
 * escritor, sea quien certifique la revisión antes de que el usuario
 * proceda a presentarla por su cuenta.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES, type OrgRole } from '@atiende/db';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { requireStepUp } from '../../lib/step-up.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { withTx, requireTender } from '../../lib/expediente/context.js';
import { loadOfficialHolidays } from '../../lib/expediente/calendar-holidays.js';
import { buildInconformidadContent, INCONFORMIDAD_DISCLAIMER } from '../../lib/expediente/inconformidad.js';
import { inconformidadGenerateSchema, inconformidadDraftSchema } from './schemas.js';

const REVIEW_ROLES: OrgRole[] = ['owner', 'admin', 'reviewer'];

function mapDraftRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    tenderId: r.tender_id,
    version: r.version,
    status: r.status,
    contentHash: r.content_hash,
    hechos: r.hechos ?? [],
    agravios: r.agravios ?? [],
    fundamentos: r.fundamentos ?? [],
    pruebas: r.pruebas ?? [],
    plazo: {
      diasHabiles: r.dias_habiles,
      fechaNotificacionFallo: r.fallo_notified_on,
      fechaLimite: r.fecha_limite,
      fundamentoLegal: r.fundamento_legal_plazo,
      bajoTratados: r.bajo_tratados,
    },
    viability: r.viability,
    viabilityRecommendation: r.viability_recommendation,
    disclaimer: r.disclaimer,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

export async function expedienteInconformidadRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/tenders/:tenderId/inconformidad',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), body: inconformidadGenerateSchema, response: { 201: inconformidadDraftSchema } },
    },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para generar un borrador de inconformidad');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const holidays = await loadOfficialHolidays(tx, request.body.falloNotifiedOn);
        const content = buildInconformidadContent({
          falloNotifiedOn: request.body.falloNotifiedOn,
          bajoTratados: request.body.bajoTratados,
          hechos: request.body.hechos,
          agravios: request.body.agravios,
          pruebas: request.body.pruebas,
          holidays,
        });

        const versionRes = await tx.query<{ next_version: number }>(
          'select coalesce(max(version), 0) + 1 as next_version from inconformidad_drafts where org_id = $1 and tender_id = $2',
          [orgId, request.params.tenderId]
        );
        const version = versionRes.rows[0].next_version;

        const id = randomUUID();
        const inserted = await tx.query<Record<string, unknown>>(
          `insert into inconformidad_drafts
             (id, org_id, tender_id, version, status, content_hash, hechos, agravios, pruebas, fundamentos,
              fallo_notified_on, bajo_tratados, dias_habiles, fecha_limite, fundamento_legal_plazo,
              viability, viability_recommendation, disclaimer, created_by)
           values ($1, $2, $3, $4, 'borrador', $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18)
           returning *`,
          [
            id,
            orgId,
            request.params.tenderId,
            version,
            content.contentHash,
            request.body.hechos,
            request.body.agravios,
            request.body.pruebas,
            JSON.stringify(content.fundamentos),
            request.body.falloNotifiedOn,
            request.body.bajoTratados,
            content.plazo.businessDays,
            content.plazo.dueDate,
            content.plazo.legalReference,
            content.viability,
            content.viabilityRecommendation,
            INCONFORMIDAD_DISCLAIMER,
            userId,
          ]
        );

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'inconformidad_draft.create',
          entity: 'inconformidad_drafts',
          entityId: id,
          after: { version, dueDate: content.plazo.dueDate, viability: content.viability },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return inserted.rows[0];
      });

      reply.code(201);
      return mapDraftRow(row);
    }
  );

  server.get(
    '/tenders/:tenderId/inconformidad',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: z.array(inconformidadDraftSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        return (
          await tx.query<Record<string, unknown>>(
            'select * from inconformidad_drafts where org_id = $1 and tender_id = $2 order by version asc',
            [orgId, request.params.tenderId]
          )
        ).rows;
      });
      return rows.map(mapDraftRow);
    }
  );

  server.post(
    '/tenders/:tenderId/inconformidad/:id/mark-reviewed',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid(), id: z.string().uuid() }), response: { 200: inconformidadDraftSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, REVIEW_ROLES, 'Solo reviewer/admin/owner pueden marcar un borrador de inconformidad como revisado');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        // REQ-053: marcar como "revisado por abogado" exige verificación en
        // dos pasos reciente -- protege que este cambio de estado interno
        // (que habilita al usuario a presentar el documento por su cuenta)
        // no ocurra por accidente ni por un rol comprometido sin 2FA.
        await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId, purpose: 'expediente.inconformidad_review' });

        await requireTender(tx, orgId, request.params.tenderId);
        const existing = await tx.query<Record<string, unknown>>(
          'select * from inconformidad_drafts where id = $1 and org_id = $2 and tender_id = $3',
          [request.params.id, orgId, request.params.tenderId]
        );
        if (existing.rows.length === 0) throw new NotFoundError('Borrador de inconformidad no encontrado');
        if (existing.rows[0].status === 'revisado') {
          throw new ConflictError('Este borrador ya fue marcado como revisado.');
        }

        const updated = await tx.query<Record<string, unknown>>(
          `update inconformidad_drafts set status = 'revisado', reviewed_by = $1, reviewed_at = now()
           where id = $2 and org_id = $3 returning *`,
          [userId, request.params.id, orgId]
        );

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'inconformidad_draft.mark_reviewed',
          entity: 'inconformidad_drafts',
          entityId: request.params.id,
          before: { status: existing.rows[0].status },
          after: { status: 'revisado' },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return updated.rows[0];
      });

      return mapDraftRow(row);
    }
  );
}
