/**
 * E6 — documentos de bases (bóveda con hash + extracción de texto) y matriz
 * de requisitos (`RequirementMatrixBuilder` de `@atiende/expediente`).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import { RequirementMatrixBuilder, RuleBasedExtractor, type TenderDocumentText } from '@atiende/expediente';
import { requireOrgRole } from '../../lib/authorize.js';
import { NotFoundError } from '../../lib/errors.js';
import { recordAudit } from '../../lib/audit.js';
import { decodeBase64Content, storeFile } from '../../lib/storage.js';
import { extractDocumentText, splitPersistedTextIntoPages } from '../../lib/expediente/text-extraction.js';
import { withTx, requireTender } from '../../lib/expediente/context.js';
import {
  documentUploadSchema,
  tenderDocumentSchema,
  requirementItemSchema,
  requirementUpdateSchema,
  requirementConflictSchema,
  conflictResolveSchema,
  matrixBuildResponseSchema,
} from './schemas.js';

function mapDocumentRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    documentKind: r.document_kind,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    fileHash: r.file_hash,
    fileSizeBytes: r.file_size_bytes,
    pageCount: r.page_count,
    textExtractionStatus: r.text_extraction_status,
    createdAt: r.created_at,
  };
}

function mapRequirementRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    documentId: r.document_id,
    requirementKind: r.requirement_kind,
    description: r.description,
    obligatoriedad: r.obligatoriedad,
    clauseRef: r.clause_ref,
    sourcePage: r.source_page,
    sourceExcerpt: r.source_excerpt,
    deadlineAt: r.deadline_at,
    responsibleRole: r.responsible_role,
    assignedTo: r.assigned_to,
    matrixStatus: r.matrix_status,
    extractedBy: r.extracted_by,
    confidence: r.confidence !== null && r.confidence !== undefined ? Number(r.confidence) : null,
    topicKey: r.topic_key,
    requiredEvidence: r.required_evidence ?? [],
    invalidatedAt: r.invalidated_at,
    invalidatedReason: r.invalidated_reason,
    createdAt: r.created_at,
  };
}

function mapConflictRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    topicKey: r.topic_key,
    kind: r.kind,
    description: r.description,
    requirementIds: r.requirement_ids ?? [],
    status: r.status,
    resolvedAt: r.resolved_at,
    resolutionNotes: r.resolution_notes,
    createdAt: r.created_at,
  };
}

export async function expedienteDocumentsRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------
  // Documentos de bases: subida (disco local + sha256) + extracción de texto.
  // -------------------------------------------------------------------------
  server.post(
    '/tenders/:tenderId/documents',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), body: documentUploadSchema, response: { 201: tenderDocumentSchema } },
    },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para subir documentos de bases');

      const buffer = decodeBase64Content(request.body.contentBase64);
      const stored = await storeFile(app.config.storageDir, orgId, buffer);
      const extraction = await extractDocumentText(buffer, { mimeType: request.body.mimeType, filename: request.body.filename });

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);

        // REQ-155/REQ-162: si YA existía al menos un documento de "bases"
        // para esta convocatoria y se sube uno nuevo del mismo tipo, se
        // trata como una NUEVA VERSIÓN de bases -- se registra un
        // `tender_change_events` ANTES de insertar el documento, lo que
        // dispara el trigger `app.invalidate_tender_dependents` (0022) y
        // marca automáticamente como pendientes de revisión los
        // requirement_items/compliance_items/proposals/approvals vigentes,
        // preservando su historial (nunca se borran). La matriz se
        // recalcula después, en `/matrix/build`, con ítems NUEVOS.
        if (request.body.documentKind === 'bases') {
          const priorBases = await tx.query<{ count: string }>(
            "select count(*)::text as count from tender_documents where org_id = $1 and tender_id = $2 and document_kind = 'bases'",
            [orgId, request.params.tenderId]
          );
          if (Number(priorBases.rows[0].count) > 0) {
            const versionId = randomUUID();
            await tx.query(
              `insert into tender_versions (id, org_id, tender_id, change_kind, source_version, payload)
               values ($1, $2, $3, 'amendment', $4, $5::jsonb)`,
              [versionId, orgId, request.params.tenderId, `bases-doc-${Date.now()}`, JSON.stringify({ filename: request.body.filename })]
            );
            await tx.query(
              `insert into tender_change_events (id, org_id, tender_id, tender_version_id, change_kind, summary)
               values ($1, $2, $3, $4, 'amendment', $5)`,
              [randomUUID(), orgId, request.params.tenderId, versionId, `Nueva versión de bases subida: ${request.body.filename}`]
            );
          }
        }

        const id = randomUUID();
        const inserted = await tx.query<Record<string, unknown>>(
          `insert into tender_documents
             (id, org_id, tender_id, document_kind, storage_ref, file_hash, extracted_text, page_count,
              uploaded_by, original_filename, mime_type, text_extraction_status, file_size_bytes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
          [
            id,
            orgId,
            request.params.tenderId,
            request.body.documentKind,
            stored.relativePath,
            stored.sha256,
            extraction.text,
            extraction.pageCount,
            userId,
            request.body.filename,
            request.body.mimeType ?? null,
            extraction.status,
            stored.sizeBytes,
          ]
        );
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'tender_document.upload',
          entity: 'tender_documents',
          entityId: id,
          after: { filename: request.body.filename, documentKind: request.body.documentKind, textExtractionStatus: extraction.status },
          requestId: request.id, correlationId: request.correlationId,
        });
        return inserted.rows[0];
      });

      reply.code(201);
      return mapDocumentRow(row);
    }
  );

  server.get(
    '/tenders/:tenderId/documents',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: z.array(tenderDocumentSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        return (await tx.query<Record<string, unknown>>('select * from tender_documents where org_id = $1 and tender_id = $2 order by created_at asc', [orgId, request.params.tenderId])).rows;
      });
      return rows.map(mapDocumentRow);
    }
  );

  // -------------------------------------------------------------------------
  // Matriz de requisitos: recalcula sobre los documentos con texto
  // extraído. Los ítems anteriores (si los hay, invalidados por el trigger
  // de cambio de bases) quedan en la tabla como historial -- esta operación
  // solo INSERTA ítems nuevos, nunca borra los previos.
  // -------------------------------------------------------------------------
  server.post(
    '/tenders/:tenderId/matrix/build',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: matrixBuildResponseSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para recalcular la matriz de requisitos');

      return withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const docsRes = await tx.query<Record<string, unknown>>(
          'select id, document_kind, original_filename, extracted_text, text_extraction_status, created_at from tender_documents where org_id = $1 and tender_id = $2 order by created_at asc',
          [orgId, request.params.tenderId]
        );

        const documentsSkipped: { documentId: string; reason: string }[] = [];
        const docs: (TenderDocumentText & { __id: string })[] = [];
        for (const row of docsRes.rows) {
          if (row.text_extraction_status !== 'extracted' || !row.extracted_text) {
            documentsSkipped.push({ documentId: String(row.id), reason: `text_extraction_status=${row.text_extraction_status}` });
            continue;
          }
          // R6-01/R6-02: `extracted_text` persiste todas las páginas
          // concatenadas con el separador `PAGE_BREAK` (form feed) --
          // `splitPersistedTextIntoPages` reconstruye el arreglo con el
          // número de página REAL de cada una (nunca una única página
          // ficticia salvo que el documento en verdad tenga una sola, p. ej.
          // texto plano o datos de antes de este cambio sin el separador).
          docs.push({
            __id: String(row.id),
            documentId: String(row.id),
            documentLabel: (row.original_filename as string | null) ?? String(row.id),
            publishedAt: new Date(row.created_at as string | Date).toISOString(),
            pages: splitPersistedTextIntoPages(String(row.extracted_text)),
          });
        }

        const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
        const result = await builder.build(docs);

        let itemsCreated = 0;
        for (const item of result.items) {
          await tx.query(
            `insert into requirement_items
               (id, org_id, tender_id, document_id, category, description, is_mandatory, source_page, source_excerpt,
                obligatoriedad, requirement_kind, clause_ref, deadline_at, responsible_role, matrix_status,
                extracted_by, confidence, topic_key, required_evidence)
             values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
            [
              orgId,
              request.params.tenderId,
              item.source.documentId,
              item.type,
              item.text,
              item.obligatoriedad === 'obligatorio',
              item.source.page,
              item.text.slice(0, 500),
              item.obligatoriedad,
              item.type,
              item.source.clause ?? null,
              item.deadline,
              item.responsibleRole,
              item.status === 'bloqueado' ? 'bloqueado' : 'pendiente',
              item.extractedBy,
              item.confidence ?? null,
              item.topicKey ?? null,
              item.requiredEvidence,
            ]
          );
          itemsCreated += 1;
        }

        let conflictsCreated = 0;
        for (const conflict of result.conflicts) {
          await tx.query(
            `insert into requirement_conflicts (id, org_id, tender_id, topic_key, kind, description, requirement_ids, status)
             values (gen_random_uuid(), $1, $2, $3, $4, $5, '{}', 'escalado')`,
            [orgId, request.params.tenderId, conflict.topicKey, conflict.kind, conflict.description]
          );
          conflictsCreated += 1;
        }

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'requirement_matrix.build',
          entity: 'requirement_items',
          entityId: request.params.tenderId,
          after: { itemsCreated, conflictsCreated, documentsUsed: docs.length },
          requestId: request.id, correlationId: request.correlationId,
        });

        return { itemsCreated, conflictsCreated, documentsUsed: docs.length, documentsSkipped };
      });
    }
  );

  server.get(
    '/tenders/:tenderId/matrix',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: {
        params: z.object({ tenderId: z.string().uuid() }),
        querystring: z.object({ includeHistory: z.enum(['true', 'false']).optional() }),
        response: { 200: z.array(requirementItemSchema) },
      },
    },
    async (request) => {
      const orgId = request.orgId!;
      const includeHistory = request.query.includeHistory === 'true';
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const condition = includeHistory ? '' : 'and invalidated_at is null';
        return (
          await tx.query<Record<string, unknown>>(
            `select * from requirement_items where org_id = $1 and tender_id = $2 ${condition} order by created_at asc`,
            [orgId, request.params.tenderId]
          )
        ).rows;
      });
      return rows.map(mapRequirementRow);
    }
  );

  server.patch(
    '/tenders/:tenderId/matrix/:id',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid(), id: z.string().uuid() }), body: requirementUpdateSchema, response: { 200: requirementItemSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para editar la matriz (responsable/estado)');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const before = await tx.query('select * from requirement_items where id = $1 and org_id = $2 and tender_id = $3', [request.params.id, orgId, request.params.tenderId]);
        if (before.rows.length === 0) return null;
        const b = request.body;
        const updated = await tx.query<Record<string, unknown>>(
          `update requirement_items set
             matrix_status = coalesce($1, matrix_status),
             assigned_to = case when $2::boolean then $3::uuid else assigned_to end
           where id = $4 and org_id = $5 returning *`,
          [b.matrixStatus ?? null, 'assignedTo' in b, b.assignedTo ?? null, request.params.id, orgId]
        );
        await recordAudit(tx, { orgId, actorId: userId, action: 'requirement_item.update', entity: 'requirement_items', entityId: request.params.id, before: before.rows[0], after: updated.rows[0], requestId: request.id, correlationId: request.correlationId });
        return updated.rows[0];
      });
      if (!row) throw new NotFoundError('Requisito no encontrado');
      return mapRequirementRow(row);
    }
  );

  // -------------------------------------------------------------------------
  // Conflictos entre documentos (incidentes visibles, REQ-166).
  // -------------------------------------------------------------------------
  server.get(
    '/tenders/:tenderId/conflicts',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: z.array(requirementConflictSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        return (await tx.query<Record<string, unknown>>('select * from requirement_conflicts where org_id = $1 and tender_id = $2 order by created_at asc', [orgId, request.params.tenderId])).rows;
      });
      return rows.map(mapConflictRow);
    }
  );

  server.post(
    '/tenders/:tenderId/conflicts/:id/resolve',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid(), id: z.string().uuid() }), body: conflictResolveSchema, response: { 200: requirementConflictSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para resolver un conflicto');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const updated = await tx.query<Record<string, unknown>>(
          `update requirement_conflicts set status = 'resuelto', resolved_at = now(), resolved_by = $1, resolution_notes = $2
           where id = $3 and org_id = $4 and tender_id = $5 returning *`,
          [userId, request.body.resolutionNotes, request.params.id, orgId, request.params.tenderId]
        );
        if (updated.rows.length === 0) return null;
        await recordAudit(tx, { orgId, actorId: userId, action: 'requirement_conflict.resolve', entity: 'requirement_conflicts', entityId: request.params.id, after: updated.rows[0], requestId: request.id, correlationId: request.correlationId });
        return updated.rows[0];
      });
      if (!row) throw new NotFoundError('Conflicto no encontrado');
      return mapConflictRow(row);
    }
  );
}
