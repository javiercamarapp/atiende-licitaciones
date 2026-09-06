/**
 * REQ-054 — autopsia del fallo: informe estructurado comparando la
 * propuesta propia contra el fallo (motivo de desechamiento,
 * puntos/criterios, precio propio vs. ganador cuando el fallo es público),
 * lecciones registradas y vinculadas al perfil de empresa. REQ-054
 * explícito: "sin inventar datos ausentes -> 'no disponible'" -- cualquier
 * campo textual no capturado se persiste literalmente como `NO_DISPONIBLE`
 * (nunca NULL/"" ambiguo, nunca inferido).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { withTx, requireTender } from '../../lib/expediente/context.js';
import { falloAutopsyCreateSchema, falloAutopsiaSchema, lessonLearnedItemSchema, NO_DISPONIBLE } from './schemas.js';

function mapAutopsyRow(r: Record<string, unknown>, lessons: string[]): any {
  return {
    id: r.id,
    tenderId: r.tender_id,
    ownProposalStatus: r.own_proposal_status,
    disqualificationReason: r.disqualification_reason,
    ownScore: r.own_score !== null && r.own_score !== undefined ? Number(r.own_score) : null,
    winnerScore: r.winner_score !== null && r.winner_score !== undefined ? Number(r.winner_score) : null,
    ownPrice: r.own_price !== null && r.own_price !== undefined ? Number(r.own_price) : null,
    winnerPrice: r.winner_price !== null && r.winner_price !== undefined ? Number(r.winner_price) : null,
    winnerName: r.winner_name,
    criteriaComparison: r.criteria_comparison ?? [],
    lessons,
    linkedToCompanyProfile: lessons.length > 0,
    createdAt: r.created_at,
  };
}

function mapLessonRow(r: Record<string, unknown>): any {
  return { id: r.id, falloAutopsyId: r.fallo_autopsy_id, tenderId: r.tender_id, lessonText: r.lesson_text, createdAt: r.created_at };
}

export async function expedienteFalloAutopsyRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/tenders/:tenderId/fallo-autopsy',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), body: falloAutopsyCreateSchema, response: { 201: falloAutopsiaSchema } },
    },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para registrar la autopsia del fallo');

      const { row, lessons } = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);

        const disqualificationReason = request.body.disqualificationReason ?? NO_DISPONIBLE;
        const winnerName = request.body.winnerName ?? NO_DISPONIBLE;

        const id = randomUUID();
        const inserted = await tx.query<Record<string, unknown>>(
          `insert into fallo_autopsies
             (id, org_id, tender_id, own_proposal_status, disqualification_reason, own_score, winner_score,
              own_price, winner_price, winner_name, criteria_comparison, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12) returning *`,
          [
            id,
            orgId,
            request.params.tenderId,
            request.body.ownProposalStatus,
            disqualificationReason,
            request.body.ownScore ?? null,
            request.body.winnerScore ?? null,
            request.body.ownPrice ?? null,
            request.body.winnerPrice ?? null,
            winnerName,
            JSON.stringify(request.body.criteriaComparison),
            userId,
          ]
        );

        // REQ-054: lecciones registradas y VINCULADAS al perfil de empresa
        // -- tabla propia, consultable org-wide (no solo por convocatoria)
        // vía GET /expediente/lessons-learned.
        const lessonTexts: string[] = [];
        for (const lessonText of request.body.lessons) {
          await tx.query(
            `insert into company_lessons_learned (id, org_id, fallo_autopsy_id, tender_id, lesson_text, created_by)
             values ($1, $2, $3, $4, $5, $6)`,
            [randomUUID(), orgId, id, request.params.tenderId, lessonText, userId]
          );
          lessonTexts.push(lessonText);
        }

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'fallo_autopsy.create',
          entity: 'fallo_autopsies',
          entityId: id,
          after: { ownProposalStatus: request.body.ownProposalStatus, disqualificationReason, lessonsCount: lessonTexts.length },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return { row: inserted.rows[0], lessons: lessonTexts };
      });

      reply.code(201);
      return mapAutopsyRow(row, lessons);
    }
  );

  server.get(
    '/tenders/:tenderId/fallo-autopsy',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: z.array(falloAutopsiaSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const autopsies = (
          await tx.query<Record<string, unknown>>('select * from fallo_autopsies where org_id = $1 and tender_id = $2 order by created_at asc', [orgId, request.params.tenderId])
        ).rows;
        const results: { row: Record<string, unknown>; lessons: string[] }[] = [];
        for (const autopsy of autopsies) {
          const lessons = (
            await tx.query<{ lesson_text: string }>('select lesson_text from company_lessons_learned where org_id = $1 and fallo_autopsy_id = $2 order by created_at asc', [
              orgId,
              autopsy.id,
            ])
          ).rows.map((l) => l.lesson_text);
          results.push({ row: autopsy, lessons });
        }
        return results;
      });
      return rows.map(({ row, lessons }) => mapAutopsyRow(row, lessons));
    }
  );

  // REQ-054: lecciones vinculadas al perfil de empresa, consultables
  // org-wide (todas las convocatorias), no solo por tender.
  server.get(
    '/lessons-learned',
    { preHandler: [app.authenticate, app.requireOrg], schema: { response: { 200: z.array(lessonLearnedItemSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) =>
        (await tx.query<Record<string, unknown>>('select * from company_lessons_learned where org_id = $1 order by created_at desc', [orgId])).rows
      );
      return rows.map(mapLessonRow);
    }
  );
}
