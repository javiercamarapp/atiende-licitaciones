/**
 * E8 — "Sala de guerra" (REQ-040): gate final que se corre a mano antes de
 * cada acto de apertura, INDEPENDIENTE del `IntegrityChecklist` (REQ-160,
 * `checklist.routes.ts`) y de `PackageAssembler` (REQ-163,
 * `package.routes.ts`), aunque reutiliza el estado REAL de ambos en vez de
 * volver a calcularlo por su cuenta:
 *
 *  - `checklist_anti_desechamiento` lee `compliance_items` (mismo checklist
 *    de integridad, `loadChecklistReport`) y el `PackageStatus` ACTUAL
 *    re-derivado (`deriveCurrentManifest`, mismo criterio AE-14 que
 *    `GET /package/latest`: un paquete "ready" cuya aprobación se invalidó
 *    DESPUÉS nunca sigue mostrándose "ready" aquí tampoco).
 *  - `hash_zip` lee el ZIP REAL en disco del último `package_manifests`
 *    (`readPackageZip` + `verifyManifest`, AE-06) -- nunca confía en el
 *    `manifest` JSONB guardado en la fila, siempre relee los bytes.
 *  - `cuenta_regresiva`/`holgura_24h` usan `tenders.submission_deadline` y
 *    el reloj real del servidor (`nowIso()`) en el momento de la corrida.
 *
 * Cada corrida se persiste como fila INMUTABLE en `war_room_checklist_runs`
 * (migración 0099) -- un historial de auditoría de "qué se verificó y
 * cuándo" antes de cada apertura, nunca se sobrescribe una corrida pasada.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import { WarRoomChecklist, verifyManifest, type ManifestVerificationResult } from '@atiende/expediente';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { withTx, requireTender, requireProposal } from '../../lib/expediente/context.js';
import { loadChecklistReport, deriveCurrentManifest } from './package.routes.js';
import { readPackageZip } from '../../lib/expediente/package-storage.js';
import { nowIso, timestampToIso } from '../../lib/expediente/dates.js';
import { warRoomReportSchema } from './schemas.js';

interface CurrentPackageState {
  status: 'draft' | 'ready' | null;
  draftReasons: string[];
  zipVerification: ManifestVerificationResult | null;
}

/**
 * Resuelve el estado ACTUAL del paquete final (para `checklist_anti_desechamiento`)
 * y verifica el ZIP REAL en disco del último ensamblado (para `hash_zip`).
 * Ningún efecto secundario de escritura -- solo lecturas, igual que
 * `GET /package/latest`.
 */
async function resolveCurrentPackageState(
  app: FastifyInstance,
  tx: Parameters<typeof loadChecklistReport>[0],
  params: { orgId: string; tenderId: string; proposalId: string }
): Promise<CurrentPackageState> {
  const { orgId, tenderId, proposalId } = params;
  const res = await tx.query<Record<string, unknown>>(
    'select * from package_manifests where org_id = $1 and proposal_id = $2 order by generated_at desc limit 1',
    [orgId, proposalId]
  );
  const row = res.rows[0] ?? null;
  if (!row) {
    return { status: null, draftReasons: [], zipVerification: null };
  }

  const storedManifest = row.manifest as { draftReasons?: string[] } | null;
  let status: 'draft' | 'ready';
  let draftReasons: string[];
  if (row.status !== 'ready') {
    // Mismo criterio que GET /package/latest: un paquete que nació "draft"
    // reporta sus propios motivos guardados, sin re-derivar (A14).
    status = 'draft';
    draftReasons = storedManifest?.draftReasons ?? [];
  } else {
    // AE-14: un paquete guardado como "ready" puede haber quedado obsoleto
    // (aprobación invalidada después) -- se re-deriva contra el estado VIVO.
    const fresh = await deriveCurrentManifest(tx, { orgId, tenderId, proposalId });
    status = fresh.status;
    draftReasons = fresh.draftReasons;
  }

  let zipVerification: ManifestVerificationResult | null = null;
  if (row.storage_ref) {
    const zipBytes = await readPackageZip(app.config.storageDir, row.storage_ref as string);
    zipVerification = await verifyManifest(zipBytes);
  }

  return { status, draftReasons, zipVerification };
}

export async function expedienteWarRoomRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/tenders/:tenderId/war-room',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: warRoomReportSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const row = await withTx(app.db, orgId, request.userId, async (tx) => {
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const res = await tx.query<Record<string, unknown>>(
          'select * from war_room_checklist_runs where org_id = $1 and proposal_id = $2 order by computed_at desc limit 1',
          [orgId, proposal.id]
        );
        return res.rows[0] ?? null;
      });
      if (!row) throw new NotFoundError('No se ha corrido el checklist de sala de guerra todavía para este expediente');
      return {
        id: row.id as string,
        overallStatus: row.overall_status as 'verde' | 'ambar' | 'rojo',
        items: row.items as unknown as z.infer<typeof warRoomReportSchema>['items'],
        hoursUntilDeadline: row.hours_until_deadline === null ? null : Number(row.hours_until_deadline),
        submissionDeadlineIso: timestampToIso(row.submission_deadline_iso as string | Date | null),
        computedAt: timestampToIso(row.computed_at as string | Date)!,
        runBy: (row.run_by as string | null) ?? null,
      };
    }
  );

  server.post(
    '/tenders/:tenderId/war-room/run',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: warRoomReportSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para correr el checklist de sala de guerra');

      const result = await withTx(app.db, orgId, userId, async (tx) => {
        const tender = await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);

        const integrityChecklist = await loadChecklistReport(tx, orgId, proposal.id as string);
        const packageState = await resolveCurrentPackageState(app, tx, { orgId, tenderId: request.params.tenderId, proposalId: proposal.id as string });
        const submissionDeadlineIso = timestampToIso(tender.submission_deadline as string | Date | null);
        const now = nowIso();

        const report = new WarRoomChecklist().run({
          // Sin ninguna corrida de checklist de integridad todavía, `loadChecklistReport`
          // devuelve `{items: [], overallStatus: 'rojo'}` (nunca `null`) -- se traduce
          // aquí a `null` para que WarRoomChecklist distinga "nunca se corrió" de
          // "se corrió y quedó en rojo", con su propio mensaje explícito.
          integrityChecklist: integrityChecklist.items.length === 0 ? null : integrityChecklist,
          packageStatus: packageState.status,
          packageDraftReasons: packageState.draftReasons,
          submissionDeadlineIso,
          nowIso: now,
          zipVerification: packageState.zipVerification,
        });

        const id = randomUUID();
        await tx.query(
          `insert into war_room_checklist_runs (id, org_id, tender_id, proposal_id, overall_status, items, hours_until_deadline, submission_deadline_iso, computed_at, run_by, correlation_id)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
          [
            id,
            orgId,
            request.params.tenderId,
            proposal.id,
            report.overallStatus,
            JSON.stringify(report.items),
            report.hoursUntilDeadline,
            submissionDeadlineIso,
            now,
            userId,
            request.correlationId ?? null,
          ]
        );

        await recordAudit(tx, {
          orgId,
          actorId: userId,
          action: 'war_room.run',
          entity: 'war_room_checklist_runs',
          entityId: id,
          after: { overallStatus: report.overallStatus, hoursUntilDeadline: report.hoursUntilDeadline },
          requestId: request.id,
          correlationId: request.correlationId,
        });

        return { id, report, submissionDeadlineIso, now };
      });

      return {
        id: result.id,
        overallStatus: result.report.overallStatus,
        items: result.report.items,
        hoursUntilDeadline: result.report.hoursUntilDeadline,
        submissionDeadlineIso: result.submissionDeadlineIso,
        computedAt: result.now,
        runBy: userId,
      };
    }
  );
}
