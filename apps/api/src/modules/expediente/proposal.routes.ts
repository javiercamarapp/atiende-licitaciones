/**
 * E7 — expediente: propuesta técnica (`TechnicalProposalBuilder`) y
 * económica (`EconomicProposalBuilder`) sobre datos REALES de empresa
 * (`CompanyDataResolver` real, `lib/expediente/company-data-resolver.pg.ts`).
 * Cálculos económicos SOLO con tarifas aprobadas y vigentes (A8): un precio
 * no aprobado/vencido bloquea el concepto completo, nunca un total parcial.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { DbExecutor } from '@atiende/db';
import { WRITE_ROLES } from '@atiende/db';
import { CompanyDataService, EconomicProposalBuilder, TechnicalProposalBuilder, type RequirementFulfillmentMapping } from '@atiende/expediente';
import { requireOrgRole } from '../../lib/authorize.js';
import { recordAudit } from '../../lib/audit.js';
import { NotFoundError, ValidationAppError } from '../../lib/errors.js';
import { withTx, requireTender, getOrCreateProposal } from '../../lib/expediente/context.js';
import { loadCompanyDataResolver } from '../../lib/expediente/company-data-resolver.pg.js';
import { loadApprovalEvents, replayWorkflow, appendApprovalEvent, persistApprovalSnapshot } from '../../lib/expediente/approval-store.pg.js';
import { nowIso, timestampToIso } from '../../lib/expediente/dates.js';
import { proposalSchema, technicalGenerateSchema, economicGenerateSchema, proposalSectionSchema, sectionUpdateSchema } from './schemas.js';

function mapProposalRow(r: Record<string, unknown>): any {
  return {
    id: r.id,
    tenderId: r.tender_id,
    title: r.title,
    status: r.status,
    version: r.version,
    invalidatedAt: r.invalidated_at,
    invalidatedReason: r.invalidated_reason,
    inputsHash: r.inputs_hash,
    ivaRate: Number(r.iva_rate),
    economicTotals: r.economic_totals,
    generationReport: r.generation_report,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapSectionRow(r: Record<string, unknown>): any {
  return { id: r.id, sectionKey: r.section_key, title: r.title, content: r.content, sources: r.sources, version: r.version, updatedAt: r.updated_at };
}

async function upsertSection(
  tx: DbExecutor,
  args: { orgId: string; proposalId: string; sectionKey: string; title: string; content: string; sources: unknown; userId: string }
): Promise<void> {
  const existing = await tx.query<{ version: number }>('select version from proposal_sections where org_id = $1 and proposal_id = $2 and section_key = $3', [args.orgId, args.proposalId, args.sectionKey]);
  const nextVersion = existing.rows.length > 0 ? Number(existing.rows[0].version) + 1 : 1;
  await tx.query(
    `insert into proposal_sections (id, org_id, proposal_id, section_key, title, content, sources, version, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8)
     on conflict (proposal_id, section_key) do update set title = excluded.title, content = excluded.content, sources = excluded.sources, version = $7, updated_by = $8`,
    [args.orgId, args.proposalId, args.sectionKey, args.title, args.content, JSON.stringify(args.sources), nextVersion, args.userId]
  );
}

export async function expedienteProposalRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/tenders/:tenderId/proposal',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: proposalSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const row = await withTx(app.db, orgId, request.userId, async (tx) => {
        const tender = await requireTender(tx, orgId, request.params.tenderId);
        return getOrCreateProposal(tx, orgId, request.params.tenderId, request.userId!, `Expediente — ${tender.title}`);
      });
      return mapProposalRow(row);
    }
  );

  server.get(
    '/tenders/:tenderId/proposal/sections',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), response: { 200: z.array(proposalSectionSchema) } } },
    async (request) => {
      const orgId = request.orgId!;
      const rows = await withTx(app.db, orgId, request.userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await tx.query<{ id: string }>('select id from proposals where org_id = $1 and tender_id = $2 limit 1', [orgId, request.params.tenderId]);
        if (proposal.rows.length === 0) return [];
        return (await tx.query<Record<string, unknown>>('select * from proposal_sections where org_id = $1 and proposal_id = $2 order by section_key asc', [orgId, proposal.rows[0].id])).rows;
      });
      return rows.map(mapSectionRow);
    }
  );

  server.patch(
    '/tenders/:tenderId/proposal/sections/:sectionKey',
    {
      preHandler: [app.authenticate, app.requireOrg],
      schema: { params: z.object({ tenderId: z.string().uuid(), sectionKey: z.string() }), body: sectionUpdateSchema, response: { 200: proposalSectionSchema } },
    },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para editar una sección de la propuesta');

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await tx.query<{ id: string }>('select id from proposals where org_id = $1 and tender_id = $2 limit 1', [orgId, request.params.tenderId]);
        if (proposal.rows.length === 0) throw new NotFoundError('No existe expediente para esta convocatoria todavía');
        const existing = await tx.query<Record<string, unknown>>('select * from proposal_sections where org_id = $1 and proposal_id = $2 and section_key = $3', [
          orgId,
          proposal.rows[0].id,
          request.params.sectionKey,
        ]);
        if (existing.rows.length === 0) throw new NotFoundError('Sección no encontrada');
        const nextVersion = Number(existing.rows[0].version) + 1;
        const updated = await tx.query<Record<string, unknown>>(
          `update proposal_sections set content = $1, version = $2, updated_by = $3 where org_id = $4 and proposal_id = $5 and section_key = $6 returning *`,
          [request.body.content, nextVersion, userId, orgId, proposal.rows[0].id, request.params.sectionKey]
        );
        // REQ-162: editar manualmente una sección ya aprobada invalida la
        // aprobación afectada (registrado como record_change al evaluarse
        // el hash actual en approval.routes.ts -- aquí basta con que el
        // insumo cambió realmente en la tabla; la invalidación automática
        // de aprobaciones ocurre en la próxima evaluación vía
        // isFullyApprovedForCurrentHash, ver approval-store.pg.ts).
        await recordAudit(tx, { orgId, actorId: userId, action: 'proposal_section.edit', entity: 'proposal_sections', entityId: existing.rows[0].id as string, before: existing.rows[0], after: updated.rows[0], requestId: request.id });
        return updated.rows[0];
      });
      return mapSectionRow(row);
    }
  );

  // -------------------------------------------------------------------------
  // Generar propuesta TÉCNICA.
  // -------------------------------------------------------------------------
  server.post(
    '/tenders/:tenderId/proposal/technical/generate',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), body: technicalGenerateSchema, response: { 200: proposalSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para generar la propuesta técnica');

      const asOfIso = request.body.asOfIso ?? nowIso();

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        const tender = await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await getOrCreateProposal(tx, orgId, request.params.tenderId, userId, `Expediente — ${tender.title}`);

        const requirementsRes = await tx.query<Record<string, unknown>>(
          "select * from requirement_items where org_id = $1 and tender_id = $2 and invalidated_at is null order by created_at asc",
          [orgId, request.params.tenderId]
        );
        const requirements = requirementsRes.rows.map((r) => ({
          id: String(r.id),
          text: String(r.description),
          source: { documentId: String(r.document_id ?? ''), documentLabel: '', page: Number(r.source_page ?? 0), clause: (r.clause_ref as string | null) ?? undefined },
          obligatoriedad: r.obligatoriedad as 'obligatorio' | 'opcional' | 'condicional',
          type: r.requirement_kind as 'tecnico' | 'economico' | 'legal' | 'administrativo' | 'anexo',
          responsibleRole: (r.responsible_role as string | null) ?? 'licitador',
          deadline: timestampToIso(r.deadline_at as string | Date | null),
          requiredEvidence: (r.required_evidence as string[] | null) ?? [],
          status: r.matrix_status === 'bloqueado' ? ('bloqueado' as const) : ('pendiente' as const),
          extractedBy: r.extracted_by as 'rule' | 'llm',
          confidence: r.confidence !== null ? Number(r.confidence) : undefined,
          topicKey: (r.topic_key as string | null) ?? undefined,
        }));

        const { resolver } = await loadCompanyDataResolver(tx, orgId, asOfIso);
        const companyData = new CompanyDataService(resolver);
        const mappings: RequirementFulfillmentMapping[] = request.body.mappings.map((m) => ({
          requirementId: m.requirementId,
          kind: m.kind,
          refKey: m.refKey,
          statementText: (value: unknown) => renderStatementText(m.kind, value),
        }));

        const builder = new TechnicalProposalBuilder(companyData);
        const result = builder.build(orgId, requirements, mappings, asOfIso, request.body.conditionEvaluations);

        const usedCompanyDocumentIds = new Set<string>();
        for (const section of result.sections) {
          const content =
            section.statements.length > 0
              ? section.statements.map((s) => s.text).join('\n')
              : `PENDIENTE: ${section.blockers.map((b) => b.detail).join(' | ')}`;
          const sources = section.statements.map((s) => s.sourceRef);
          for (const stmt of section.statements) {
            const mapping = mappings.find((m) => m.requirementId === section.requirementId);
            if (mapping?.kind === 'document') usedCompanyDocumentIds.add(stmt.sourceRef.kind === 'company_data' ? stmt.sourceRef.refId : '');
          }
          await upsertSection(tx, { orgId, proposalId: proposal.id as string, sectionKey: `technical:${section.requirementId}`, title: section.title, content, sources, userId });
        }

        const existingReport = (proposal.generation_report as Record<string, unknown> | null) ?? {};
        const previousTechnical = existingReport.technical as { conditionEvaluations?: Record<string, boolean> } | undefined;
        const generationReport = {
          ...existingReport,
          technical: {
            usedCompanyDocumentIds: [...usedCompanyDocumentIds].filter(Boolean),
            blockers: result.blockers,
            generatedAt: nowIso(),
            conditionEvaluations: request.body.conditionEvaluations,
          },
        };
        const updated = await tx.query<Record<string, unknown>>(
          `update proposals set generation_report = $1::jsonb, version = version + 1, invalidated_at = null, invalidated_reason = null where id = $2 and org_id = $3 returning *`,
          [JSON.stringify(generationReport), proposal.id, orgId]
        );

        // Coordinación packages/expediente (docs/auditoria-1/expediente-cierre.md):
        // `conditionEvaluations` (si un requisito CONDICIONAL aplica al caso
        // concreto) NO forma parte de `ExpedienteInputs` -- computeInputsHash
        // no cambia si solo cambia esta declaración, así que un cambio de
        // aplicabilidad NUNCA invalidaría una aprobación vigente por la vía
        // del hash de insumos. Se invalida EXPLÍCITAMENTE aquí, con el mismo
        // mecanismo (recordChange + evento persistido) que usa un cambio de
        // bases, cada vez que la nueva generación usa una declaración
        // distinta de la anterior para al menos un requisito.
        const changedRequirementIds = diffConditionEvaluations(previousTechnical?.conditionEvaluations, request.body.conditionEvaluations);
        if (previousTechnical !== undefined && changedRequirementIds.length > 0) {
          const events = await loadApprovalEvents(tx, orgId, proposal.id as string);
          const workflow = replayWorkflow(events);
          const reason = `condicion_de_requisito_cambio:${changedRequirementIds.join(',')}`;
          const change = workflow.recordChange({ scope: 'documento', scopeRef: 'documento:tecnica', reason });
          if (change.invalidatedApprovalIds.length > 0) {
            await appendApprovalEvent(tx, { orgId, proposalId: proposal.id as string, kind: 'record_change', actorId: userId, actorRole: request.orgRole!, scope: 'documento', scopeRef: 'documento:tecnica', reason });
            await persistApprovalSnapshot(tx, orgId, proposal.id as string, workflow);
            await recordAudit(tx, {
              orgId,
              actorId: userId,
              action: 'approval.invalidate_by_condition_change',
              entity: 'proposal_approvals',
              entityId: proposal.id as string,
              after: { changedRequirementIds, invalidatedApprovalIds: change.invalidatedApprovalIds },
              requestId: request.id,
            });
          }
        }

        await recordAudit(tx, { orgId, actorId: userId, action: 'proposal.technical.generate', entity: 'proposals', entityId: proposal.id as string, after: { blockers: result.blockers.length, sections: result.sections.length }, requestId: request.id });
        return updated.rows[0];
      });
      return mapProposalRow(row);
    }
  );

  // -------------------------------------------------------------------------
  // Generar propuesta ECONÓMICA (A8: solo tarifas aprobadas y vigentes).
  // -------------------------------------------------------------------------
  server.post(
    '/tenders/:tenderId/proposal/economic/generate',
    { preHandler: [app.authenticate, app.requireOrg], schema: { params: z.object({ tenderId: z.string().uuid() }), body: economicGenerateSchema, response: { 200: proposalSchema } } },
    async (request) => {
      const orgId = request.orgId!;
      const userId = request.userId!;
      requireOrgRole(request, WRITE_ROLES, 'Se requiere un rol de escritura para generar la propuesta económica');
      const asOfIso = request.body.asOfIso ?? nowIso();

      const row = await withTx(app.db, orgId, userId, async (tx) => {
        const tender = await requireTender(tx, orgId, request.params.tenderId);
        const proposal = await getOrCreateProposal(tx, orgId, request.params.tenderId, userId, `Expediente — ${tender.title}`);

        const { resolver } = await loadCompanyDataResolver(tx, orgId, asOfIso);
        const companyData = new CompanyDataService(resolver);
        const ivaRate = Number(proposal.iva_rate ?? 0.16);
        const builder = new EconomicProposalBuilder(companyData, { ivaRate });
        const result = builder.build(orgId, request.body.lineItems, asOfIso);

        if (result.totals && result.cartaText && result.anexoText) {
          await upsertSection(tx, {
            orgId,
            proposalId: proposal.id as string,
            sectionKey: 'economic:carta',
            title: 'Carta de proposición económica',
            content: result.cartaText,
            sources: result.lineItems.map((li) => li.sourceRef),
            userId,
          });
          await upsertSection(tx, {
            orgId,
            proposalId: proposal.id as string,
            sectionKey: 'economic:anexo',
            title: 'Anexo económico',
            content: result.anexoText,
            sources: result.lineItems.map((li) => li.sourceRef),
            userId,
          });
        }

        const usedRateConcepts = result.lineItems.map((li) => li.concept);
        const existingReport = (proposal.generation_report as Record<string, unknown> | null) ?? {};
        const generationReport = {
          ...existingReport,
          economic: { usedRateConcepts, blockedLineItems: result.blockedLineItems, totals: result.totals, generatedAt: nowIso() },
        };
        const updated = await tx.query<Record<string, unknown>>(
          `update proposals set generation_report = $1::jsonb, economic_totals = $2::jsonb, version = version + 1, invalidated_at = null, invalidated_reason = null where id = $3 and org_id = $4 returning *`,
          [JSON.stringify(generationReport), result.totals ? JSON.stringify(result.totals) : null, proposal.id, orgId]
        );
        await recordAudit(tx, { orgId, actorId: userId, action: 'proposal.economic.generate', entity: 'proposals', entityId: proposal.id as string, after: { blockedLineItems: result.blockedLineItems.length, hasTotals: result.totals !== null }, requestId: request.id });
        return updated.rows[0];
      });
      return mapProposalRow(row);
    }
  );
}

function renderStatementText(kind: RequirementFulfillmentMapping['kind'], value: unknown): string {
  const v = value as Record<string, unknown>;
  switch (kind) {
    case 'capability':
      return `La empresa cuenta con la capacidad "${v.name}"${v.description ? `: ${v.description}` : ''}.`;
    case 'experience':
      return `Experiencia acreditada: ${v.description}.`;
    case 'document':
      return `Se presenta el documento vigente "${v.label}" (tipo: ${v.type}).`;
    case 'signer':
      return `Firmante autorizado: ${v.name} (${v.role}).`;
    default:
      throw new ValidationAppError({ kind: 'tipo de mapeo no reconocido' });
  }
}

/**
 * Compara la declaración de aplicabilidad de requisitos condicionales
 * (`conditionEvaluations`, ver technicalGenerateSchema) entre la generación
 * anterior y la actual, y devuelve los `requirementId` cuyo valor cambió
 * (incluye un requisito que antes no tenía declaración y ahora sí, o
 * viceversa). Nunca compara por referencia de objeto -- solo por valor.
 */
function diffConditionEvaluations(previous: Record<string, boolean> | undefined, current: Record<string, boolean>): string[] {
  const prev = previous ?? {};
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(prev), ...Object.keys(current)])) {
    if (prev[key] !== current[key]) changed.add(key);
  }
  return [...changed].sort();
}
