/**
 * E8/E9 — `PackageAssembler` real: manifiesto + ZIP en disco
 * (`STORAGE_DIR`), descarga autenticada. `status` se DERIVA siempre dentro
 * de `PackageAssembler.buildManifest` (checklist verde + aprobación vigente
 * de alcance "expediente" con hash de insumos coincidente + sin faltantes)
 * -- esta ruta nunca declara "ready" por su cuenta (A13/A14).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DbExecutor } from '@atiende/db';
import { WRITE_ROLES } from '@atiende/db';
import { PackageAssembler, type ChecklistReport, type PackageDocumentInput } from '@atiende/expediente';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { withTx, requireTender, requireProposal, collectUsedInputs } from '../../lib/expediente/context.js';
import { loadApprovalEvents, replayWorkflow } from '../../lib/expediente/approval-store.pg.js';
import { getCurrentSealedInputs } from '../../lib/expediente/inputs.js';
import { writePackageZip, readPackageZip } from '../../lib/expediente/package-storage.js';
import { packageAssembleResponseSchema } from './schemas.js';

async function loadChecklistReport(tx: DbExecutor, orgId: string, proposalId: string): Promise<ChecklistReport> {
  const rows = (
    await tx.query<Record<string, unknown>>(
      "select * from compliance_items where org_id = $1 and proposal_id = $2 and dimension is not null and invalidated_at is null order by dimension asc",
      [orgId, proposalId]
    )
  ).rows;
  const items = rows.map((r: Record<string, unknown>) => ({ dimension: r.dimension, status: r.result, detail: r.notes ?? '', evidence: (r.evidence_ref as string | null)?.split(', ').filter(Boolean) ?? [] })) as ChecklistReport['items'];
  const overallStatus = items.some((i) => i.status === 'rojo') ? 'rojo' : items.length === 0 ? 'rojo' : items.some((i) => i.status === 'ambar') ? 'ambar' : 'verde';
  return { items, overallStatus };
}

export async function expedientePackageRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post(
    '/tenders/:tenderId/package/assemble',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: packageAssembleResponseSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para ensamblar el paquete');

      const { manifest } = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);

        const sectionsRes = await tx.query<Record<string, unknown>>('select * from proposal_sections where org_id = $1 and proposal_id = $2 order by section_key asc', [orgId, proposal.id]);
        const documents: PackageDocumentInput[] = sectionsRes.rows.map((s) => {
          const content = String(s.content);
          const blocked = content.startsWith('PENDIENTE');
          return { documentId: String(s.id), label: String(s.title), required: true, filename: `${s.section_key}.txt`, version: Number(s.version), content: blocked ? undefined : content };
        });

        const checklist = await loadChecklistReport(tx, orgId, proposal.id as string);
        const events = await loadApprovalEvents(tx, orgId, proposal.id as string);
        const workflow = replayWorkflow(events);
        const { usedCompanyDocumentIds, usedRateConcepts } = await collectUsedInputs(tx, orgId, proposal.id as string);
        const sealed = await getCurrentSealedInputs(tx, { orgId, tenderId: request.params.tenderId, usedCompanyDocumentIds, usedRateConcepts });

        const assembler = new PackageAssembler();
        const result = await assembler.assemble({
          expedienteId: proposal.id as string,
          documents,
          checklist,
          approvals: workflow.listApprovals(),
          currentInputsHash: sealed,
        });

        const storageRef = await writePackageZip(app.config.storageDir, orgId, proposal.id as string, result.zip);
        await tx.query(
          `insert into package_manifests (id, org_id, proposal_id, status, manifest, checklist_snapshot, generated_by, storage_ref, inputs_hash)
           values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
          [randomUUID(), orgId, proposal.id, result.manifest.status, JSON.stringify(result.manifest), JSON.stringify(checklist), userId, storageRef, sealed.hash]
        );

        await recordAudit(tx, { orgId, actorId: userId, action: 'package.assemble', entity: 'package_manifests', entityId: proposal.id as string, after: { status: result.manifest.status, draftReasons: result.manifest.draftReasons }, requestId: request.id });

        return { manifest: result.manifest, zip: result.zip };
      });

      return {
        id: manifest.expedienteId,
        status: manifest.status,
        draftReasons: manifest.draftReasons,
        missing: manifest.missing,
        generatedAt: manifest.generatedAt,
        notice: manifest.notice,
      };
    }
  );

  server.get(
    '/tenders/:tenderId/package/latest',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: packageAssembleResponseSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const row = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const res = await tx.query<Record<string, unknown>>('select * from package_manifests where org_id = $1 and proposal_id = $2 order by generated_at desc limit 1', [orgId, proposal.id]);
        return res.rows[0] ?? null;
      });
      if (!row) throw new NotFoundError('No se ha generado ningún paquete todavía para este expediente');
      const manifest = row.manifest as { draftReasons?: string[]; missing?: string[]; notice?: string };
      return {
        id: row.proposal_id as string,
        status: row.status as 'draft' | 'ready',
        draftReasons: manifest.draftReasons ?? [],
        missing: manifest.missing ?? [],
        generatedAt: row.generated_at as string,
        notice: manifest.notice ?? '',
      };
    }
  );

  server.get(
    '/tenders/:tenderId/package/download',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }) } },
    async (request, reply) => {
      const orgId = request.orgId!;
      const row = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const res = await tx.query<Record<string, unknown>>('select * from package_manifests where org_id = $1 and proposal_id = $2 order by generated_at desc limit 1', [orgId, proposal.id]);
        return res.rows[0] ?? null;
      });
      if (!row || !row.storage_ref) throw new NotFoundError('No se ha generado ningún paquete descargable todavía');
      const buffer = await readPackageZip(app.config.storageDir, row.storage_ref as string);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="expediente-${row.proposal_id}.zip"`);
      return reply.send(buffer);
    }
  );
}
