/**
 * REQ-051 (máquina de estados del contrato post-adjudicación) y REQ-052
 * (extracción del contrato firmado) -- ronda 6.
 *
 * REQ-051: `contracts` (una fila por convocatoria) + `contract_status_history`
 * (inmutable). El catálogo de transiciones válidas vive en
 * `lib/expediente/contract-lifecycle.ts`; una transición inválida responde
 * 409 con el detalle de los estados permitidos, nunca aplica un cambio
 * parcial.
 *
 * REQ-052: el usuario SUBE el contrato firmado -- este módulo NUNCA firma
 * ni verifica una firma real. Reutiliza `extractDocumentText` (E6) para el
 * texto (mismo motor que bases: PDF con capa de texto o texto plano; sin
 * OCR -> `requires_ocr`, nunca se inventa contenido). Los campos detectados
 * quedan en estado `'sugerido'` hasta que el usuario los confirma o corrige
 * explícitamente (`POST .../fields/:id/confirm`) -- ninguna ruta de esta
 * ronda da un campo extraído por válido sin esa confirmación.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { requireStepUp } from '../../lib/step-up.js';
import { NotFoundError, ConflictError, ValidationAppError } from '../../lib/errors.js';
import { withTx, requireTender } from '../../lib/expediente/context.js';
import { decodeBase64Content, storeFile } from '../../lib/storage.js';
import { extractDocumentText } from '../../lib/expediente/text-extraction.js';
import { extractContractFields } from '../../lib/expediente/contract-extraction.js';
import {
  CONTRACT_INITIAL_STATUS,
  CONTRACT_ALERT_STATES,
  CONTRACT_STEP_UP_TRANSITIONS,
  checkTransition,
  isContractStatus,
  type ContractStatus,
} from '../../lib/expediente/contract-lifecycle.js';
import {
  contractSchema,
  contractTransitionRequestSchema,
  contractStatusHistoryItemSchema,
  contractMetadataUpdateSchema,
  contractDocumentUploadSchema,
  contractDocumentSchema,
  contractExtractedFieldSchema,
  contractFieldConfirmSchema,
} from './schemas.js';

function mapContractRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    tenderId: r.tender_id,
    status: r.status,
    endDate: r.end_date ?? null,
    contractNumber: r.contract_number ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapHistoryRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    reason: r.reason,
    actorId: r.actor_id,
    evidenceRef: r.evidence_ref,
    createdAt: r.created_at,
  };
}

function mapContractDocumentRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    contractId: r.contract_id,
    originalFilename: r.original_filename,
    mimeType: r.mime_type,
    fileHash: r.file_hash,
    fileSizeBytes: r.file_size_bytes,
    pageCount: r.page_count,
    textExtractionStatus: r.text_extraction_status,
    extractionDetail: r.extraction_detail,
    createdAt: r.created_at,
  };
}

function mapExtractedFieldRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    contractDocumentId: r.contract_document_id,
    fieldKey: r.field_key,
    extractedValue: r.extracted_value,
    sourcePage: r.source_page,
    sourceClause: r.source_clause,
    confidence: r.confidence !== null && r.confidence !== undefined ? Number(r.confidence) : null,
    status: r.status,
    confirmedValue: r.confirmed_value,
    confirmedBy: r.confirmed_by,
    confirmedAt: r.confirmed_at,
    createdAt: r.created_at,
  };
}

async function requireContract(tx: import('@atiende/db').DbExecutor, orgId: string, tenderId: string): Promise<Record<string, unknown>> {
  const res = await tx.query<Record<string, unknown>>('select * from contracts where org_id = $1 and tender_id = $2', [orgId, tenderId]);
  if (res.rows.length === 0) {
    throw new NotFoundError('No existe contrato registrado para esta convocatoria todavía; regístrelo primero con POST /expediente/tenders/:tenderId/contract.');
  }
  return res.rows[0];
}

export async function expedienteContractRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  // -------------------------------------------------------------------------
  // REQ-051: alta y consulta del contrato.
  // -------------------------------------------------------------------------
  server.post(
    '/tenders/:tenderId/contract',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 201: contractSchema } } },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para registrar un contrato');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const existing = await tx.query('select id from contracts where org_id = $1 and tender_id = $2', [orgId, request.params.tenderId]);
        if (existing.rows.length > 0) {
          throw new ConflictError('Ya existe un contrato registrado para esta convocatoria.');
        }
        const id = randomUUID();
        const inserted = await tx.query<Record<string, unknown>>(
          `insert into contracts (id, org_id, tender_id, status, created_by) values ($1, $2, $3, $4, $5) returning *`,
          [id, orgId, request.params.tenderId, CONTRACT_INITIAL_STATUS, userId]
        );
        await tx.query(
          `insert into contract_status_history (id, org_id, contract_id, from_status, to_status, reason, actor_id, correlation_id)
           values ($1, $2, $3, null, $4, $5, $6, $7)`,
          [randomUUID(), orgId, id, CONTRACT_INITIAL_STATUS, 'Alta del contrato tras adjudicación.', userId, request.correlationId ?? null]
        );
        await recordAudit(tx, {
          orgId, actorId: userId, action: 'contract.create', entity: 'contracts', entityId: id,
          after: { tenderId: request.params.tenderId, status: CONTRACT_INITIAL_STATUS },
          requestId: request.id, correlationId: request.correlationId,
        });
        return inserted.rows[0];
      });

      reply.code(201);
      return mapContractRow(row);
    }
  );

  server.get(
    '/tenders/:tenderId/contract',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: contractSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const row = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        return requireContract(tx, orgId, request.params.tenderId);
      });
      return mapContractRow(row);
    }
  );

  // REQ-055: metadatos administrativos (fecha de fin/número de contrato) --
  // NO es una transición de estado (no pasa por el grafo ni genera fila de
  // historial); es el insumo directo que consume el radar de renovaciones.
  server.patch(
    '/tenders/:tenderId/contract',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), body: contractMetadataUpdateSchema, response: { 200: contractSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para actualizar los metadatos del contrato');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const contract = await requireContract(tx, orgId, request.params.tenderId);
        const b = request.body;
        const updated = await tx.query<Record<string, unknown>>(
          `update contracts set
             end_date = case when $1::boolean then $2::date else end_date end,
             contract_number = case when $3::boolean then $4 else contract_number end
           where id = $5 and org_id = $6 returning *`,
          ['endDate' in b, b.endDate ?? null, 'contractNumber' in b, b.contractNumber ?? null, contract.id, orgId]
        );
        await recordAudit(tx, {
          orgId, actorId: userId, action: 'contract.update_metadata', entity: 'contracts', entityId: contract.id as string,
          before: { endDate: contract.end_date, contractNumber: contract.contract_number },
          after: { endDate: updated.rows[0].end_date, contractNumber: updated.rows[0].contract_number },
          requestId: request.id, correlationId: request.correlationId,
        });
        return updated.rows[0];
      });

      return mapContractRow(row);
    }
  );

  server.get(
    '/tenders/:tenderId/contract/history',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: z.array(contractStatusHistoryItemSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const contract = await requireContract(tx, orgId, request.params.tenderId);
        return (
          await tx.query<Record<string, unknown>>(
            'select * from contract_status_history where org_id = $1 and contract_id = $2 order by created_at asc',
            [orgId, contract.id]
          )
        ).rows;
      });
      return rows.map(mapHistoryRow);
    }
  );

  server.post(
    '/tenders/:tenderId/contract/transition',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), body: contractTransitionRequestSchema, response: { 200: contractSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para transicionar el estado de un contrato');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const contract = await requireContract(tx, orgId, request.params.tenderId);
        const fromStatus = contract.status as ContractStatus;
        const toStatus = request.body.toStatus;

        if (!isContractStatus(toStatus)) {
          throw new ValidationAppError({ toStatus: 'Estado de contrato desconocido.' });
        }
        const check = checkTransition(fromStatus, toStatus);
        if (!check.valid) {
          throw new ConflictError(
            `Transición inválida: "${fromStatus}" -> "${toStatus}". Estados permitidos desde "${fromStatus}": ${check.allowedNextStates.length > 0 ? check.allowedNextStates.join(', ') : '(ninguno; estado terminal)'}.`,
            { fromStatus, toStatus, allowedNextStates: check.allowedNextStates }
          );
        }

        // REQ-051: rescindir/penalizar/marcar en inconformidad/registrar una
        // modificación son decisiones económicas/legales sensibles -- exigen
        // verificación en dos pasos reciente (2FA), mismo mecanismo que
        // aprobar un expediente (ver lib/step-up.ts). Se verifica DESPUÉS de
        // validar que la transición es válida en el grafo (para no gastar un
        // step-up de un solo uso en una transición que de todos modos iba a
        // rechazarse con 409), pero ANTES de escribir ningún cambio.
        if (CONTRACT_STEP_UP_TRANSITIONS.includes(toStatus)) {
          await requireStepUp(tx, { userId, stepUpHeader: request.headers['x-step-up'], orgId, purpose: 'expediente.contract_transition' });
        }

        // R6-04 (docs/auditoria-2/api-ronda6.md, MEDIA): el `SELECT` de
        // `requireContract` de arriba NO bloquea la fila -- dos transiciones
        // concurrentes que parten del MISMO `fromStatus` podrían pasar
        // ambas la validación en memoria (`checkTransition`) y, si el
        // `UPDATE` no condicionara sobre el estado previo, ambas tendrían
        // éxito (una pisando el historial de la otra). Se condiciona el
        // `UPDATE` a `status = $fromStatus` (patrón ya usado en
        // `company/routes.ts` para `approved_rates.approve/reject` y en
        // `agents/routes.ts` para `tool_calls`): bajo READ COMMITTED,
        // Postgres bloquea la fila mientras la otra transacción concurrente
        // está en vuelo y, al liberarse, vuelve a evaluar el `WHERE` contra
        // el valor YA COMMITTEADO -- si el estado cambió mientras tanto,
        // esta actualización afecta 0 filas en vez de aplicar un cambio
        // basado en un estado que ya no es el vigente.
        const updated = await tx.query<Record<string, unknown>>(
          'update contracts set status = $1 where id = $2 and org_id = $3 and status = $4 returning *',
          [toStatus, contract.id, orgId, fromStatus]
        );
        if (updated.rows.length === 0) {
          const current = await tx.query<{ status: string }>('select status from contracts where id = $1 and org_id = $2', [contract.id, orgId]);
          const currentStatus = current.rows[0]?.status ?? fromStatus;
          throw new ConflictError(
            `El estado del contrato cambió mientras se procesaba esta transición (de "${fromStatus}" ya pasó a "${currentStatus}" por otra solicitud). Reintente la transición partiendo del estado actual.`,
            { fromStatus, toStatus, currentStatus }
          );
        }

        await tx.query(
          `insert into contract_status_history (id, org_id, contract_id, from_status, to_status, reason, actor_id, evidence_ref, correlation_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [randomUUID(), orgId, contract.id, fromStatus, toStatus, request.body.reason, userId, request.body.evidenceRef ?? null, request.correlationId ?? null]
        );

        // Alertas por estado (REQ-051): sin envío externo, se encola un job
        // inerte -- mismo patrón que `post_award_followup_reminder`
        // (apps/worker consume la cola; ningún kind implica enviar nada a
        // un tercero en esta ronda).
        if (CONTRACT_ALERT_STATES.includes(toStatus)) {
          await tx.query(
            `insert into jobs (id, org_id, kind, payload, status, next_run_at, correlation_id)
             values ($1, $2, 'contract_state_alert', $3::jsonb, 'queued', now(), $4)`,
            [
              randomUUID(),
              orgId,
              JSON.stringify({ tenderId: request.params.tenderId, contractId: contract.id, fromStatus, toStatus, reason: request.body.reason }),
              request.correlationId ?? null,
            ]
          );
        }

        await recordAudit(tx, {
          orgId, actorId: userId, action: 'contract.transition', entity: 'contracts', entityId: contract.id as string,
          before: { status: fromStatus }, after: { status: toStatus, reason: request.body.reason },
          requestId: request.id, correlationId: request.correlationId,
        });

        return updated.rows[0];
      });

      return mapContractRow(row);
    }
  );

  // -------------------------------------------------------------------------
  // REQ-052: subida + extracción del contrato firmado.
  // -------------------------------------------------------------------------
  server.post(
    '/tenders/:tenderId/contract/documents',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid() }), body: contractDocumentUploadSchema, response: { 201: contractDocumentSchema } },
    },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para subir el contrato firmado');

      const buffer = decodeBase64Content(request.body.contentBase64);
      const stored = await storeFile(app.config.storageDir, orgId, buffer);
      const extraction = await extractDocumentText(buffer, { mimeType: request.body.mimeType, filename: request.body.filename });

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const contract = await requireContract(tx, orgId, request.params.tenderId);

        const id = randomUUID();
        const inserted = await tx.query<Record<string, unknown>>(
          `insert into contract_documents
             (id, org_id, contract_id, storage_ref, file_hash, extracted_text, page_count,
              uploaded_by, original_filename, mime_type, text_extraction_status, extraction_detail, file_size_bytes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
          [
            id, orgId, contract.id, stored.relativePath, stored.sha256, extraction.text, extraction.pageCount,
            userId, request.body.filename, request.body.mimeType ?? null, extraction.status, extraction.detail ?? null, stored.sizeBytes,
          ]
        );

        // REQ-052: campos detectados quedan SIEMPRE en estado 'sugerido' --
        // nunca se dan por válidos sin la confirmación explícita del
        // usuario (ver `POST .../fields/:fieldId/confirm`).
        let fieldsExtracted = 0;
        if (extraction.status === 'extracted' && extraction.pages) {
          const fields = extractContractFields(extraction.pages);
          for (const field of fields) {
            await tx.query(
              `insert into contract_extracted_fields
                 (id, org_id, contract_document_id, field_key, extracted_value, source_page, source_clause, confidence, status)
               values ($1, $2, $3, $4, $5, $6, $7, $8, 'sugerido')`,
              [randomUUID(), orgId, id, field.fieldKey, field.value, field.sourcePage, field.sourceClause ?? null, field.confidence]
            );
            fieldsExtracted += 1;
          }
        }

        await recordAudit(tx, {
          orgId, actorId: userId, action: 'contract_document.upload', entity: 'contract_documents', entityId: id,
          after: { filename: request.body.filename, textExtractionStatus: extraction.status, fieldsExtracted },
          requestId: request.id, correlationId: request.correlationId,
        });
        return inserted.rows[0];
      });

      reply.code(201);
      return mapContractDocumentRow(row);
    }
  );

  server.get(
    '/tenders/:tenderId/contract/documents',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: z.array(contractDocumentSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const contract = await requireContract(tx, orgId, request.params.tenderId);
        return (await tx.query<Record<string, unknown>>('select * from contract_documents where org_id = $1 and contract_id = $2 order by created_at asc', [orgId, contract.id])).rows;
      });
      return rows.map(mapContractDocumentRow);
    }
  );

  server.get(
    '/tenders/:tenderId/contract/documents/:documentId/fields',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid(), documentId: z.string().uuid() }), response: { 200: z.array(contractExtractedFieldSchema) } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const contract = await requireContract(tx, orgId, request.params.tenderId);
        // R6-05 (docs/auditoria-2/api-ronda6.md, BAJA): la URL anida
        // `tenderId` -> contrato -> documento -> campos, pero antes solo se
        // verificaba `documentId` contra `org_id` (aislamiento de
        // organización), nunca contra el contrato REAL de ESE `tenderId` --
        // un `documentId` válido de OTRO contrato de la misma organización
        // pasaba igual. Hoy no es explotable como escalación de privilegios
        // (la autorización de escritura ya es a nivel de organización
        // completa), pero rompería silenciosamente si el producto introduce
        // algún día permisos más finos por convocatoria/contrato -- se
        // corrige aquí para que la URL diga la verdad.
        const doc = await tx.query('select id from contract_documents where id = $1 and org_id = $2 and contract_id = $3', [request.params.documentId, orgId, contract.id]);
        if (doc.rows.length === 0) throw new NotFoundError('Documento de contrato no encontrado');
        return (
          await tx.query<Record<string, unknown>>(
            'select * from contract_extracted_fields where org_id = $1 and contract_document_id = $2 order by created_at asc',
            [orgId, request.params.documentId]
          )
        ).rows;
      });
      return rows.map(mapExtractedFieldRow);
    }
  );

  server.post(
    '/tenders/:tenderId/contract/fields/:fieldId/confirm',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: {
        params: z.object({ tenderId: z.string().uuid(), fieldId: z.string().uuid() }),
        body: contractFieldConfirmSchema,
        response: { 200: contractExtractedFieldSchema },
      },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para confirmar/corregir un campo extraído del contrato');

      if (request.body.action === 'correct' && !request.body.correctedValue) {
        throw new ValidationAppError({ correctedValue: 'Obligatorio cuando action="correct".' });
      }

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const contract = await requireContract(tx, orgId, request.params.tenderId);
        // R6-05: mismo anidamiento real que en el GET de arriba -- el campo
        // debe pertenecer a un documento del contrato de ESTE `tenderId`,
        // no solo a la organización.
        const existing = await tx.query<Record<string, unknown>>(
          `select f.* from contract_extracted_fields f
             join contract_documents d on d.id = f.contract_document_id and d.org_id = f.org_id
           where f.id = $1 and f.org_id = $2 and d.contract_id = $3`,
          [request.params.fieldId, orgId, contract.id]
        );
        if (existing.rows.length === 0) throw new NotFoundError('Campo extraído no encontrado');

        const newStatus = request.body.action === 'confirm' ? 'confirmado' : 'corregido';
        const confirmedValue = request.body.action === 'confirm' ? (existing.rows[0].extracted_value as string | null) : request.body.correctedValue!;

        const updated = await tx.query<Record<string, unknown>>(
          `update contract_extracted_fields
             set status = $1, confirmed_value = $2, confirmed_by = $3, confirmed_at = now()
           where id = $4 and org_id = $5 returning *`,
          [newStatus, confirmedValue, userId, request.params.fieldId, orgId]
        );

        await recordAudit(tx, {
          orgId, actorId: userId, action: 'contract_extracted_field.confirm', entity: 'contract_extracted_fields', entityId: request.params.fieldId,
          before: existing.rows[0], after: updated.rows[0],
          requestId: request.id, correlationId: request.correlationId,
        });
        return updated.rows[0];
      });

      return mapExtractedFieldRow(row);
    }
  );
}
