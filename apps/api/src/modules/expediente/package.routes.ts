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
import { PackageAssembler, type ChecklistReport, type PackageDocumentInput, type PackageManifest } from '@atiende/expediente';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { withTx, requireTender, requireProposal, collectUsedInputs } from '../../lib/expediente/context.js';
import { loadApprovalEvents, replayWorkflow } from '../../lib/expediente/approval-store.pg.js';
import { getCurrentSealedInputs } from '../../lib/expediente/inputs.js';
import { writePackageZip, readPackageZip } from '../../lib/expediente/package-storage.js';
import { fireAndForgetMail } from '../../lib/mail/pending.js';
import { notifySubmissionPackageReadyToResponsibles } from '../../lib/mail/submission-package-notify.js';
import { timestampToIso } from '../../lib/expediente/dates.js';
import { packageAssembleResponseSchema } from './schemas.js';

/** Exportado para reutilizarse en `war-room.routes.ts` (REQ-040): misma fuente de verdad del checklist de integridad, nunca una segunda lectura ad hoc de `compliance_items`. */
export async function loadChecklistReport(tx: DbExecutor, orgId: string, proposalId: string): Promise<ChecklistReport> {
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

/**
 * AE-14 (docs/auditoria-2/api-expediente-reverificacion.md, MEDIA):
 * `GET /package/latest`/`/package/download` devolvían SIEMPRE el
 * `status`/`manifest` guardado en la última fila de `package_manifests`
 * -- si la aprobación vigente se invalidaba DESPUÉS de ensamblar (p. ej.
 * por un cambio de perfil de empresa, AE-08, o de una sección, AE-02), el
 * paquete seguía mostrándose "ready" indefinidamente hasta el próximo
 * `POST /package/assemble` manual, sirviendo/anunciando un ZIP "listo"
 * que ya no refleja el estado real del expediente.
 *
 * `deriveCurrentManifest` recalcula el `PackageManifest` REAL contra el
 * estado vivo de la base de datos (mismo insumo que `PackageAssembler`
 * usa en `/package/assemble`: checklist + aprobaciones + hash de insumos
 * ACTUAL), sin volver a escribir el ZIP ni la fila de `package_manifests`
 * -- una lectura (`GET`) nunca debe tener efectos secundarios de
 * escritura. `GET /package/latest` reporta siempre este estado
 * recién derivado (nunca el `status` guardado a secas); `GET
 * /package/download` rechaza con 409 explícito si el paquete guardado
 * ERA "ready" pero ya no lo es, en vez de servir el ZIP viejo.
 */
/** Exportado para reutilizarse en `war-room.routes.ts` (REQ-040): mismo criterio AE-14 de re-derivar el estado ACTUAL del paquete, nunca confiar en el `status` guardado de la última corrida. */
export async function deriveCurrentManifest(
  tx: DbExecutor,
  params: { orgId: string; tenderId: string; proposalId: string }
): Promise<PackageManifest> {
  const { orgId, tenderId, proposalId } = params;
  const sectionsRes = await tx.query<Record<string, unknown>>('select * from proposal_sections where org_id = $1 and proposal_id = $2 order by section_key asc', [orgId, proposalId]);
  const documents: PackageDocumentInput[] = sectionsRes.rows.map((s) => {
    const content = String(s.content);
    const blocked = content.startsWith('PENDIENTE');
    return { documentId: String(s.id), label: String(s.title), required: true, filename: `${s.section_key}.txt`, version: Number(s.version), content: blocked ? undefined : content };
  });

  const checklist = await loadChecklistReport(tx, orgId, proposalId);
  const events = await loadApprovalEvents(tx, orgId, proposalId);
  const workflow = replayWorkflow(events);
  const { usedCompanyDocumentIds, usedRateConcepts } = await collectUsedInputs(tx, orgId, proposalId);
  const sealed = await getCurrentSealedInputs(tx, { orgId, tenderId, usedCompanyDocumentIds, usedRateConcepts });

  const assembler = new PackageAssembler();
  const result = await assembler.assemble({
    expedienteId: proposalId,
    documents,
    checklist,
    approvals: workflow.listApprovals(),
    currentInputsHash: sealed,
  });
  return result.manifest;
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

      const { manifest, tenderTitle, submissionDeadlineIso } = await withTx(app.db, orgId, userId, async (tx) => {
        const tender = await requireTender(tx, orgId, request.params.tenderId);
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
          // REQ-171: se propaga al manifiesto DENTRO del ZIP (aditivo, ver
          // `packages/expediente/src/package-assembler.ts`), además de la
          // columna `correlation_id` de `package_manifests` abajo.
          correlationId: request.correlationId ?? null,
        });

        const storageRef = await writePackageZip(app.config.storageDir, orgId, proposal.id as string, result.zip);
        await tx.query(
          `insert into package_manifests (id, org_id, proposal_id, status, manifest, checklist_snapshot, generated_by, storage_ref, inputs_hash, correlation_id)
           values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`,
          [randomUUID(), orgId, proposal.id, result.manifest.status, JSON.stringify(result.manifest), JSON.stringify(checklist), userId, storageRef, sealed.hash, request.correlationId ?? null]
        );

        await recordAudit(tx, { orgId, actorId: userId, action: 'package.assemble', entity: 'package_manifests', entityId: proposal.id as string, after: { status: result.manifest.status, draftReasons: result.manifest.draftReasons }, requestId: request.id, correlationId: request.correlationId });

        return {
          manifest: result.manifest,
          zip: result.zip,
          tenderTitle: String(tender.title),
          submissionDeadlineIso: timestampToIso(tender.submission_deadline as string | Date | null),
        };
      });

      // REQ-181 (plantilla `submission-package-ready`): el paquete de esta
      // llamada quedó REALMENTE "ready" (decidido por `PackageAssembler`
      // arriba, nunca por esta ruta -- A13/A14) -- se notifica a los
      // miembros responsables en segundo plano, DESPUÉS del commit. Un
      // re-ensamblado posterior del MISMO expediente que sigue "ready" no
      // manda un segundo correo: `sendSubmissionPackageReadyEmail` usa una
      // `messageKey` estable por (usuario, convocatoria), idempotente por
      // diseño (ver `triggers.ts`).
      if (manifest.status === 'ready') {
        fireAndForgetMail(app, 'submission-package-ready', () =>
          notifySubmissionPackageReadyToResponsibles(app, {
            organizationId: orgId,
            tenderId: request.params.tenderId,
            tenderTitle,
            submissionDeadlineIso,
            manifest,
          })
        );
      }

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
      const result = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const res = await tx.query<Record<string, unknown>>('select * from package_manifests where org_id = $1 and proposal_id = $2 order by generated_at desc limit 1', [orgId, proposal.id]);
        const row = res.rows[0] ?? null;
        if (!row) return null;
        const storedManifest = row.manifest as { draftReasons?: string[]; missing?: string[]; notice?: string };
        // AE-14: `row.status`/`row.manifest` reflejan el momento del ÚLTIMO
        // `assemble`, no el estado ACTUAL. Solo importa re-derivar cuando
        // el último assemble había quedado "ready" -- ahí es donde una
        // aprobación invalidada DESPUÉS (AE-08/AE-02) podía seguir
        // mostrándose "ready" indefinidamente. Un paquete que YA nació
        // "draft" (nunca llegó a "ready") sigue reportando su propio
        // draftReasons/missing guardados, sin cambios de comportamiento
        // (A14: motivos explícitos del momento en que se ensambló).
        if (row.status !== 'ready') {
          return {
            proposalId: proposal.id as string,
            generatedAt: row.generated_at as string,
            status: 'draft' as const,
            draftReasons: storedManifest.draftReasons ?? [],
            missing: storedManifest.missing ?? [],
            notice: storedManifest.notice ?? '',
          };
        }
        const fresh = await deriveCurrentManifest(tx, { orgId, tenderId: request.params.tenderId, proposalId: proposal.id as string });
        return {
          proposalId: proposal.id as string,
          generatedAt: row.generated_at as string,
          status: fresh.status,
          draftReasons: fresh.draftReasons,
          missing: fresh.missing,
          notice: fresh.notice,
        };
      });
      if (!result) throw new NotFoundError('No se ha generado ningún paquete todavía para este expediente');
      return {
        id: result.proposalId,
        status: result.status,
        draftReasons: result.draftReasons,
        missing: result.missing,
        generatedAt: result.generatedAt,
        notice: result.notice,
      };
    }
  );

  server.get(
    '/tenders/:tenderId/package/download',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }) } },
    async (request, reply) => {
      const orgId = request.orgId!;
      const result = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const res = await tx.query<Record<string, unknown>>('select * from package_manifests where org_id = $1 and proposal_id = $2 order by generated_at desc limit 1', [orgId, proposal.id]);
        const row = res.rows[0] ?? null;
        if (!row) return { kind: 'not_found' as const };
        if (!row.storage_ref) return { kind: 'not_found' as const };
        // AE-14: el ZIP guardado en disco (`storage_ref`) corresponde al
        // último `assemble`. Un paquete que ya nació "draft" sigue siendo
        // descargable tal cual (A14: el propio ZIP documenta sus motivos
        // en manifiesto.json, sin cambios de comportamiento). El caso que
        // SÍ se corrige aquí es el de un paquete que SÍ llegó a "ready" y
        // cuya aprobación se invalidó DESPUÉS (AE-08/AE-02): nunca se sirve
        // ese ZIP "ready" viejo como si siguiera vigente.
        if (row.status === 'ready') {
          const fresh = await deriveCurrentManifest(tx, { orgId, tenderId: request.params.tenderId, proposalId: proposal.id as string });
          if (fresh.status !== 'ready') {
            return { kind: 'stale' as const, manifest: fresh };
          }
        }
        return { kind: 'ok' as const, proposalId: proposal.id as string, storageRef: row.storage_ref as string };
      });
      if (result.kind === 'not_found') throw new NotFoundError('No se ha generado ningún paquete descargable todavía');
      if (result.kind === 'stale') {
        throw new ConflictError(
          'El paquete generado quedó desactualizado (la aprobación vigente ya no cubre el estado actual del expediente, o el checklist dejó de estar en verde). Vuelve a ejecutar POST /package/assemble.',
          { draftReasons: result.manifest.draftReasons, missing: result.manifest.missing }
        );
      }
      const buffer = await readPackageZip(app.config.storageDir, result.storageRef);
      reply.header('Content-Type', 'application/zip');
      reply.header('Content-Disposition', `attachment; filename="expediente-${result.proposalId}.zip"`);
      return reply.send(buffer);
    }
  );
}
