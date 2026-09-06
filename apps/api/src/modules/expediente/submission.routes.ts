/**
 * E9 (A15) — `submissions` SOLO registra que el usuario DECLARA haber
 * presentado su propuesta (fecha, acuse subido por el propio usuario).
 * Este módulo JAMÁS envía nada a un portal externo: no existe ningún
 * cliente HTTP saliente hacia un portal de licitaciones en todo este
 * archivo (ver `test/expediente-e2e-flow.test.ts`, que además escanea el
 * código fuente de este módulo para verificarlo, mismo patrón que
 * `packages/expediente/test/api-surface.test.ts`).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { decodeBase64Content, storeFile } from '../../lib/storage.js';
import { withTx, requireTender, requireProposal } from '../../lib/expediente/context.js';
import { submissionDeclareSchema, submissionSchema } from './schemas.js';

function mapSubmissionRow(r: Record<string, unknown>): any {
  return { id: r.id, status: r.status, submittedAt: r.submitted_at, acknowledgementStorageRef: r.acknowledgement_storage_ref, notes: r.notes, createdAt: r.created_at };
}

export async function expedienteSubmissionRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/tenders/:tenderId/submission',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: submissionSchema.nullable() } } },
    async (request) => {
      const orgId = request.orgId!;
      const row = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await tx.query<{ id: string }>('select id from proposals where org_id = $1 and tender_id = $2 limit 1', [orgId, request.params.tenderId]);
        if (proposal.rows.length === 0) return null;
        const res = await tx.query<Record<string, unknown>>('select * from submissions where org_id = $1 and proposal_id = $2 order by created_at desc limit 1', [orgId, proposal.rows[0].id]);
        return res.rows[0] ?? null;
      });
      return row ? mapSubmissionRow(row) : null;
    }
  );

  server.post(
    '/tenders/:tenderId/submission/declare',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), body: submissionDeclareSchema, response: { 201: submissionSchema } } },
    async (request, reply) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para declarar la presentación');

      let ackStorageRef: string | null = null;
      let ackHash: string | null = null;
      if (request.body.acknowledgementContentBase64) {
        const buffer = decodeBase64Content(request.body.acknowledgementContentBase64);
        const stored = await storeFile(app.config.storageDir, orgId, buffer);
        ackStorageRef = stored.relativePath;
        ackHash = stored.sha256;
      }

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const id = randomUUID();
        const inserted = await tx.query<Record<string, unknown>>(
          `insert into submissions (id, org_id, proposal_id, status, submitted_by, submitted_at, acknowledgement_storage_ref, acknowledgement_file_hash, notes)
           values ($1, $2, $3, 'submitted', $4, $5, $6, $7, $8) returning *`,
          [id, orgId, proposal.id, userId, request.body.submittedAt, ackStorageRef, ackHash, request.body.notes ?? null]
        );
        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'submission.declare',
          entity: 'submissions',
          entityId: id,
          after: { submittedAt: request.body.submittedAt, hasAcknowledgement: ackStorageRef !== null, declaredByUser: true },
          requestId: request.id, correlationId: request.correlationId,
        });
        return inserted.rows[0];
      });

      reply.code(201);
      return mapSubmissionRow(row);
    }
  );
}

// NOTA A15 (verificable estáticamente, ver test/expediente-e2e-flow.test.ts):
// este archivo no importa 'http', 'https', 'node:http', 'node:https',
// 'undici' ni ninguna librería de cliente HTTP saliente. La única red que
// toca esta API es la que Fastify expone hacia adentro (peticiones
// entrantes), nunca hacia un portal de licitaciones.
export const NO_OUTBOUND_HTTP_CLIENT_IN_THIS_MODULE = true;
