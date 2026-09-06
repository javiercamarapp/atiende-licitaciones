/**
 * E8 — `IntegrityChecklist` real persistida en `compliance_items`. Las 7
 * dimensiones (REQ-160) se recalculan sobre datos reales: requisitos de
 * anexo obligatorio de la matriz, documentos de empresa efectivamente
 * usados (con vigencia real) y el resultado económico de la última
 * generación. `files`/`formatLimits`/`requiredSignatures`/
 * `presentAnnexRefs` son declarados por el llamador (ver schemas.ts): este
 * proyecto no modela un "casillero de portal" ni un tablero de firmas
 * propio todavía -- decisión de alcance documentada, no inferencia
 * fabricada.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WRITE_ROLES } from '@atiende/db';
import { IntegrityChecklist, type EconomicProposalResult } from '@atiende/expediente';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { withTx, requireTender, requireProposal, readGenerationReport } from '../../lib/expediente/context.js';
import { loadCompanyDataResolver } from '../../lib/expediente/company-data-resolver.pg.js';
import { nowIso, resolveExpedienteAsOfIso } from '../../lib/expediente/dates.js';
import { checklistRunSchema, checklistReportSchema } from './schemas.js';

function mapComplianceRow(r: Record<string, unknown>): any {
  return { id: r.id, dimension: r.dimension, result: r.result, label: r.label, notes: r.notes, evidenceRef: r.evidence_ref, checkedAt: r.checked_at };
}

export async function expedienteChecklistRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/tenders/:tenderId/checklist',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: checklistReportSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await tx.query<{ id: string }>('select id from proposals where org_id = $1 and tender_id = $2 limit 1', [orgId, request.params.tenderId]);
        if (proposal.rows.length === 0) return [];
        return (
          await tx.query<Record<string, unknown>>(
            "select * from compliance_items where org_id = $1 and proposal_id = $2 and dimension is not null and invalidated_at is null order by dimension asc",
            [orgId, proposal.rows[0].id]
          )
        ).rows;
      });
      const items = rows.map(mapComplianceRow);
      const overallStatus: 'verde' | 'ambar' | 'rojo' = items.some((i) => i.result === 'rojo') ? 'rojo' : items.some((i) => i.result === 'ambar') ? 'ambar' : 'verde';
      return { overallStatus, items };
    }
  );

  server.post(
    '/tenders/:tenderId/checklist/run',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), body: checklistRunSchema, response: { 200: checklistReportSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para ejecutar el checklist de integridad');

      const report = await withTx(app.db, orgId, userId, async (tx) => {
        const tender = await requireTender(tx, orgId, request.params.tenderId);
        // AE-01: `asOfIso` del cuerpo de la petición se ignora por completo;
        // ver lib/expediente/dates.ts (resolveExpedienteAsOfIso).
        const asOfIso = resolveExpedienteAsOfIso(tender);
        const proposal = await requireProposal(tx, orgId, request.params.tenderId);
        const generationReport = await readGenerationReport(tx, orgId, proposal.id as string);

        const requiredAnnexesRes = await tx.query<Record<string, unknown>>(
          "select * from requirement_items where org_id = $1 and tender_id = $2 and requirement_kind = 'anexo' and obligatoriedad = 'obligatorio' and invalidated_at is null",
          [orgId, request.params.tenderId]
        );
        const requiredAnnexes = requiredAnnexesRes.rows.map((r) => ({
          id: String(r.id),
          text: String(r.description),
          topicKey: (r.topic_key as string | null) ?? undefined,
          source: { documentId: String(r.document_id ?? ''), documentLabel: '', page: Number(r.source_page ?? 0) },
          obligatoriedad: 'obligatorio' as const,
          type: 'anexo' as const,
          responsibleRole: (r.responsible_role as string | null) ?? 'licitador',
          deadline: null,
          requiredEvidence: (r.required_evidence as string[] | null) ?? [],
          status: 'pendiente' as const,
          extractedBy: r.extracted_by as 'rule' | 'llm',
        }));

        const { documents } = await loadCompanyDataResolver(tx, orgId, asOfIso);
        const usedDocIds = new Set(generationReport.technical?.usedCompanyDocumentIds ?? []);
        const documentsToValidate = documents.filter((d) => usedDocIds.has(d.id)).map((document) => ({ document, asOfIso }));

        let economicResult: EconomicProposalResult | null = null;
        const crossDocumentTotals: { documentLabel: string; total: string }[] = [];
        if (generationReport.economic?.totals) {
          const totals = generationReport.economic.totals as EconomicProposalResult['totals'];
          economicResult = {
            lineItems: (generationReport.economic.usedRateConcepts ?? []).map((concept) => ({
              concept,
              quantity: 0,
              unitPriceCents: 0n,
              subtotalCents: 0n,
              sourceRef: { kind: 'company_data' as const, refId: concept, capturedAt: asOfIso },
            })),
            blockedLineItems: (generationReport.economic.blockedLineItems ?? []) as EconomicProposalResult['blockedLineItems'],
            totals,
            cartaText: null,
            anexoText: null,
          };
          crossDocumentTotals.push({ documentLabel: 'carta', total: totals!.total }, { documentLabel: 'anexo', total: totals!.total });
        } else if (generationReport.economic) {
          economicResult = {
            lineItems: [],
            blockedLineItems: (generationReport.economic.blockedLineItems ?? []) as EconomicProposalResult['blockedLineItems'],
            totals: null,
            cartaText: null,
            anexoText: null,
          };
        }

        const checklist = new IntegrityChecklist();
        const result = checklist.run({
          files: request.body.files,
          formatLimits: request.body.formatLimits,
          requiredSignatures: request.body.requiredSignatures,
          requiredAnnexes,
          presentAnnexRefs: request.body.presentAnnexRefs,
          documentsToValidate,
          economicResult,
          crossDocumentTotals,
        });

        await tx.query('delete from compliance_items where org_id = $1 and proposal_id = $2 and dimension is not null', [orgId, proposal.id]);
        for (const item of result.items) {
          await tx.query(
            `insert into compliance_items (id, org_id, tender_id, proposal_id, label, status, evidence_ref, notes, dimension, result, checked_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
            [
              randomUUID(),
              orgId,
              request.params.tenderId,
              proposal.id,
              item.dimension,
              item.status === 'verde' ? 'complete' : item.status === 'rojo' ? 'rejected' : 'in_progress',
              item.evidence.join(', ').slice(0, 2000) || null,
              item.detail,
              item.dimension,
              item.status,
            ]
          );
        }

        await recordAudit(tx, { orgId, actorId: userId, action: 'checklist.run', entity: 'compliance_items', entityId: proposal.id as string, after: { overallStatus: result.overallStatus }, requestId: request.id });

        return { overallStatus: result.overallStatus, items: result.items.map((i) => ({ id: randomUUID(), dimension: i.dimension, result: i.status, label: i.detail, notes: i.detail, evidenceRef: evidenceToString(i.evidence), checkedAt: nowIso() })) };
      });
      return report;
    }
  );
}

function evidenceToString(evidence: string[]): string | null {
  return evidence.length > 0 ? evidence.join(', ').slice(0, 2000) : null;
}
