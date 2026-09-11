/**
 * REQ-035 ("Cada dato renderizado en la propuesta lleva procedencia
 * (`proposal_facts` con fuente, doc_id, página)", tolerancia cero) -- wiring
 * real entre los `SourceRef` que YA produce `packages/expediente`
 * (`TechnicalProposalBuilder`/`EconomicProposalBuilder`) y la tabla
 * `proposal_facts` (packages/db/migrations/0101_req035_proposal_facts.sql).
 *
 * Nunca se fabrica un `doc_id`/página aquí: esta capa solo desestructura el
 * `SourceRef` real que ya trae cada `ProposalStatement`/`EconomicLineItem` y
 * lo persiste tal cual. Si un llamador intentara pasar un hecho sin
 * `SourceRef` (no es posible de forma normal: `SourceRef` no es opcional en
 * ninguno de esos tipos), el CHECK `chk_proposal_facts_doc_id_not_blank` de
 * la migración lo rechazaría igual a nivel de esquema.
 */
import type { DbExecutor } from '@atiende/db';
import type { SourceRef } from '@atiende/expediente';

export interface ProposalFactInput {
  /** Identificador determinista y re-generable del hecho (p. ej. `technical:<requirementId>:<indice>`). */
  factKey: string;
  /** El texto/valor tal como se renderizó en la propuesta. */
  renderedValue: string;
  sourceRef: SourceRef;
}

/**
 * Reemplaza TODOS los hechos existentes de `sectionKey` por los de `facts`,
 * en una sola operación (mismo patrón idempotente que `upsertSection` para
 * `proposal_sections`): si una regeneración produce menos hechos que la
 * anterior (p. ej. un requisito que antes resolvía ahora queda bloqueado),
 * los hechos sobrantes de la vez anterior se eliminan -- nunca queda un
 * hecho trazando algo que ya no se renderiza.
 */
export async function recordProposalFacts(
  tx: DbExecutor,
  args: { orgId: string; proposalId: string; sectionKey: string; facts: ProposalFactInput[] }
): Promise<void> {
  await tx.query('delete from proposal_facts where org_id = $1 and proposal_id = $2 and section_key = $3', [
    args.orgId,
    args.proposalId,
    args.sectionKey,
  ]);

  for (const fact of args.facts) {
    const { sourceRef } = fact;
    const docId = sourceRef.kind === 'clause' ? sourceRef.documentId : sourceRef.refId;
    const page = sourceRef.kind === 'clause' ? sourceRef.page : null;
    const clause = sourceRef.kind === 'clause' ? (sourceRef.clause ?? null) : null;
    const capturedAt = sourceRef.kind === 'company_data' ? sourceRef.capturedAt : null;

    await tx.query(
      `insert into proposal_facts (org_id, proposal_id, fact_key, section_key, rendered_value, source_kind, doc_id, page, clause, captured_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [args.orgId, args.proposalId, fact.factKey, args.sectionKey, fact.renderedValue, sourceRef.kind, docId, page, clause, capturedAt]
    );
  }
}
