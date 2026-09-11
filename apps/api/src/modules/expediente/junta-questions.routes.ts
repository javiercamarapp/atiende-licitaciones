/**
 * REQ-041 — preguntas de junta de aclaraciones con fuente verificable.
 * `POST /tenders/:tenderId/junta-questions/generate` recalcula la matriz de
 * requisitos EN VIVO sobre los documentos con texto extraído de la
 * convocatoria (mismo criterio que `POST /matrix/build`: siempre a partir de
 * documentos reales, nunca de una matriz potencialmente obsoleta ya
 * persistida) y produce, con
 * `generateJuntaQuestions` (`@atiende/expediente`), las preguntas fundadas
 * para la junta -- cada una con su(s) fuente(s) verificable(s)
 * (documento + página + cita textual). Ninguna pregunta se muestra al
 * usuario sin fuente: el generador ya lo garantiza en código
 * (`packages/expediente/src/junta-questions.ts`), y el esquema de respuesta
 * (`juntaQuestionSchema.sources.min(1)`) es una segunda defensa a nivel de
 * contrato de API.
 *
 * Cada corrida se persiste como un registro INMUTABLE en
 * `junta_question_runs` (mismo patrón que `war_room_checklist_runs`,
 * migración 0099) -- nunca se sobrescribe una corrida anterior; generar de
 * nuevo (p. ej. tras subir un acta de aclaraciones adicional) crea una fila
 * nueva y dependerá de las evidencias de la corrida usada para el escrito
 * real que se presente.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import { RequirementMatrixBuilder, RuleBasedExtractor, generateJuntaQuestions, type TenderDocumentText } from '@atiende/expediente';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { withTx, requireTender } from '../../lib/expediente/context.js';
import { splitPersistedTextIntoPages } from '../../lib/expediente/text-extraction.js';
import { juntaQuestionsGenerateRequestSchema, juntaQuestionRunSchema, juntaQuestionRunsListSchema } from './schemas.js';

function mapRunRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    tenderId: r.tender_id,
    juntaAclaracionesAt: r.junta_aclaraciones_at,
    questionsDueAt: r.questions_due_at,
    withinWindow: r.within_window,
    questions: r.questions ?? [],
    rejected: r.rejected ?? [],
    documentsUsed: r.documents_used,
    computedAt: r.computed_at,
  };
}

export async function expedienteJuntaQuestionsRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/tenders/:tenderId/junta-questions/generate',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: {
        params: z.object({ tenderId: z.string().uuid() }),
        body: juntaQuestionsGenerateRequestSchema,
        response: { 201: juntaQuestionRunSchema },
      },
    },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para generar preguntas de junta');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);

        // Mismos documentos y mismo criterio de "solo lo realmente
        // extraído" que `POST /matrix/build` -- un documento aún en
        // `requires_ocr`/`failed`/`pending` no aporta texto real que
        // analizar, así que se excluye (nunca se fabrica contenido).
        const docsRes = await tx.query<Record<string, unknown>>(
          'select id, original_filename, extracted_text, text_extraction_status from tender_documents where org_id = $1 and tender_id = $2 order by created_at asc',
          [orgId, request.params.tenderId]
        );

        const docs: TenderDocumentText[] = [];
        for (const docRow of docsRes.rows) {
          if (docRow.text_extraction_status !== 'extracted' || !docRow.extracted_text) continue;
          docs.push({
            documentId: String(docRow.id),
            documentLabel: (docRow.original_filename as string | null) ?? String(docRow.id),
            publishedAt: new Date().toISOString(),
            pages: splitPersistedTextIntoPages(String(docRow.extracted_text)),
          });
        }

        const { items, conflicts } = await new RequirementMatrixBuilder([new RuleBasedExtractor()]).build(docs);
        const { questions: rawQuestions, rejected, window } = generateJuntaQuestions({
          items,
          conflicts,
          juntaAclaracionesAt: request.body.juntaAclaracionesAt,
        });
        // Normaliza `undefined` -> `null` (topicKey/clause son opcionales en
        // el dominio de @atiende/expediente, pero un `undefined` desaparece
        // silenciosamente al serializar a JSON -- `jsonb` lo persistiría sin
        // la clave, y el esquema de respuesta la exige explícita) antes de
        // persistir, para que la fila en `junta_question_runs` sea
        // exactamente lo que el contrato de API promete.
        const questions = rawQuestions.map((q) => ({
          ...q,
          topicKey: q.topicKey ?? null,
          sources: q.sources.map((s) => ({ ...s, clause: s.clause ?? null })),
        }));

        const id = randomUUID();
        const inserted = await tx.query<Record<string, unknown>>(
          `insert into junta_question_runs
             (id, org_id, tender_id, junta_aclaraciones_at, questions_due_at, within_window, questions, questions_count, rejected, documents_used, computed_by, correlation_id)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12)
           returning *`,
          [
            id,
            orgId,
            request.params.tenderId,
            window.juntaAclaracionesAt,
            window.questionsDueAt,
            window.isWithinWindow,
            JSON.stringify(questions),
            questions.length,
            JSON.stringify(rejected),
            docs.length,
            userId,
            request.correlationId ?? null,
          ]
        );

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'junta_questions.generate',
          entity: 'junta_question_runs',
          entityId: id,
          after: { questionsCount: questions.length, rejectedCount: rejected.length, documentsUsed: docs.length, withinWindow: window.isWithinWindow },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return inserted.rows[0];
      });

      reply.code(201);
      return mapRunRow(row);
    }
  );

  server.get(
    '/tenders/:tenderId/junta-questions',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: juntaQuestionRunsListSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        return (
          await tx.query<Record<string, unknown>>(
            'select * from junta_question_runs where org_id = $1 and tender_id = $2 order by computed_at desc',
            [orgId, request.params.tenderId]
          )
        ).rows;
      });
      return rows.map(mapRunRow);
    }
  );
}
