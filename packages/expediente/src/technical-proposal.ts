/**
 * TechnicalProposalBuilder (REQ-157/REQ-164): construye la propuesta
 * técnica exclusivamente a partir de datos de empresa en estado APROBADO,
 * mapeando cada `RequirementItem` técnico/administrativo/legal/anexo a un
 * `ProposalStatement` con `source_ref` trazable. Ningún dato faltante o no
 * aprobado se rellena: se acumula como bloqueo explícito de esa sección.
 */
import type { RequirementItem } from "./requirement-matrix.js";
import type { CompanyDataService, FieldResolution } from "./company-data.js";
import { isResolved } from "./company-data.js";
import type { SourceRef } from "./types.js";

export interface ProposalStatement {
  id: string;
  text: string;
  sourceRef: SourceRef;
}

export interface SectionBlocker {
  requirementId: string;
  field: string;
  status: "missing" | "blocked";
  detail: string;
}

export interface ProposalSection {
  id: string;
  requirementId: string;
  title: string;
  statements: ProposalStatement[];
  blockers: SectionBlocker[];
}

export interface TechnicalProposal {
  sections: ProposalSection[];
  blockers: SectionBlocker[];
}

/**
 * Estrategia de mapeo: para cada requisito, qué campo(s) de la empresa se
 * necesitan para redactarlo. El llamador (apps/api en producción, tests
 * aquí) decide esta correspondencia — este paquete no adivina qué
 * capacidad/documento corresponde a un texto libre de las bases.
 */
export interface RequirementFulfillmentMapping {
  requirementId: string;
  /** Tipo de dato de empresa a resolver para este requisito. */
  kind: "capability" | "experience" | "document" | "signer";
  /** Nombre/tipo/rol/id a resolver según `kind`. */
  refKey: string;
  /** Texto de la afirmación a incluir si el dato resuelve OK; se le antepone contexto del requisito. */
  statementText: (value: unknown) => string;
}

/**
 * Evalúa si un requisito debe tratarse como "obligatorio-como" (genera
 * sección PENDIENTE + bloqueo cuando no tiene evidencia mapeable) o si es
 * genuinamente procedimental (se omite en silencio):
 *  - `obligatoriedad === "obligatorio"` -> siempre "obligatorio".
 *  - `obligatoriedad === "opcional"` -> siempre "no_aplica" (procedimental).
 *  - `obligatoriedad === "condicional"` -> depende de si el LLAMADOR declaró
 *    explícitamente (vía `conditionEvaluations[requirement.id]`) si la
 *    condición aplica al caso concreto:
 *      - `false` declarado explícitamente -> "no_aplica" (procedimental
 *        real, p. ej. un anuncio de plazo — nunca se infiere solo del valor
 *        de `obligatoriedad`, EX-EXP-12).
 *      - `true` declarado explícitamente -> "condicional_aplica" (se trata
 *        como obligatorio).
 *      - no declarado (`undefined`) -> "no_evaluable": fail-closed, se trata
 *        como obligatorio con un bloqueo distinto que lo deja explícito,
 *        en vez de desaparecer en silencio (EX-EXP-03/EX-EXP-12).
 */
type ObligatorioLike = "obligatorio" | "condicional_aplica" | "no_evaluable" | "no_aplica";

function evaluateObligatorioLike(
  requirement: RequirementItem,
  conditionEvaluations: Readonly<Record<string, boolean>>,
): ObligatorioLike {
  if (requirement.obligatoriedad === "obligatorio") return "obligatorio";
  if (requirement.obligatoriedad === "opcional") return "no_aplica";
  // "condicional"
  const applies = Object.prototype.hasOwnProperty.call(conditionEvaluations, requirement.id)
    ? conditionEvaluations[requirement.id]
    : undefined;
  if (applies === false) return "no_aplica";
  if (applies === true) return "condicional_aplica";
  return "no_evaluable";
}

export class TechnicalProposalBuilder {
  constructor(private readonly companyData: CompanyDataService) {}

  build(
    companyId: string,
    requirements: RequirementItem[],
    mappings: RequirementFulfillmentMapping[],
    asOfIso: string,
    /**
     * EX-EXP-03/EX-EXP-12: declaración EXPLÍCITA por requisito de si un
     * `obligatoriedad === "condicional"` aplica al caso concreto (`true`),
     * no aplica (`false`, procedimental real), o se omite (no evaluado,
     * tratado como "no evaluable" — fail-closed). Nunca se infiere solo del
     * valor de `obligatoriedad`: un requisito condicional NUNCA desaparece
     * en silencio sin que el llamador lo haya marcado explícitamente como
     * no aplicable.
     */
    conditionEvaluations: Readonly<Record<string, boolean>> = {},
  ): TechnicalProposal {
    const relevantTypes = new Set(["tecnico", "administrativo", "legal", "anexo"]);
    const sections: ProposalSection[] = [];
    const globalBlockers: SectionBlocker[] = [];

    for (const requirement of requirements) {
      if (!relevantTypes.has(requirement.type)) continue;

      if (requirement.requiredEvidence.length === 0) {
        const kind = evaluateObligatorioLike(requirement, conditionEvaluations);
        if (kind === "no_aplica") {
          // Requisito verdaderamente procedimental (opcional, o condicional
          // que el llamador declaró explícitamente como NO aplicable al
          // caso concreto, p. ej. un anuncio de plazo): no genera sección de
          // propuesta ni bloqueo — se gestiona solo como fila de la
          // matriz/checklist de plazos, no como afirmación a redactar.
          continue;
        }
        // REQ-158/EX-EXP-03/EX-EXP-12: un requisito OBLIGATORIO (o
        // CONDICIONAL que aplica, o cuya aplicabilidad no fue evaluada)
        // sin evidencia que el extractor sepa mapear (p. ej. la
        // manifestación de no estar en los supuestos de los arts. 50/60
        // LAASSP, o una declaración de integridad) NUNCA se omite en
        // silencio. Queda como sección explícita "PENDIENTE" con un
        // bloqueo que exige mapeo manual (o confirmación humana de
        // aplicabilidad) antes de poder redactarse — el requisito nunca
        // desaparece del pipeline.
        const blocker: SectionBlocker =
          kind === "no_evaluable"
            ? {
                requirementId: requirement.id,
                field: "condicion_no_evaluable",
                status: "missing",
                detail:
                  "Requisito condicional cuya aplicabilidad al caso concreto no fue evaluada explícitamente por el llamador; se trata como obligatorio por precaución (fail-closed) hasta que un humano confirme si aplica o no.",
              }
            : {
                requirementId: requirement.id,
                field: "evidencia_no_mapeable",
                status: "missing",
                detail:
                  "Requisito obligatorio (o condicional que aplica) sin evidencia requerida reconocida por el extractor de reglas; requiere mapeo manual (o ampliar el extractor) antes de poder redactarse.",
              };
        sections.push({ id: `sec-${requirement.id}`, requirementId: requirement.id, title: `PENDIENTE: ${requirement.text}`, statements: [], blockers: [blocker] });
        globalBlockers.push(blocker);
        continue;
      }

      if (requirement.status === "bloqueado") {
        // Requisito con conflicto sin resolver (p. ej. plazo contradictorio): la sección
        // completa queda bloqueada, nunca se redacta sobre un requisito en disputa.
        const blocker: SectionBlocker = {
          requirementId: requirement.id,
          field: "requisito",
          status: "blocked",
          detail: "Requisito con conflicto abierto entre documentos; requiere resolución humana antes de redactar.",
        };
        sections.push({ id: `sec-${requirement.id}`, requirementId: requirement.id, title: requirement.text, statements: [], blockers: [blocker] });
        globalBlockers.push(blocker);
        continue;
      }

      const mapping = mappings.find((m) => m.requirementId === requirement.id);
      const statements: ProposalStatement[] = [];
      const blockers: SectionBlocker[] = [];

      if (!mapping) {
        // Sin mapeo declarado: no hay forma trazable de redactar este requisito
        // desde datos de empresa; queda pendiente en vez de usar texto genérico.
        blockers.push({ requirementId: requirement.id, field: "mapeo_no_declarado", status: "missing", detail: "No se declaró de qué dato de empresa se redacta este requisito." });
      } else {
        const resolution = this.resolveMapping(companyId, mapping, asOfIso);
        if (isResolved(resolution)) {
          statements.push({
            id: `stmt-${requirement.id}`,
            text: mapping.statementText(resolution.value),
            sourceRef: { kind: "company_data", refId: resolution.sourceRef.docId, capturedAt: resolution.sourceRef.capturedAt },
          });
        } else if (resolution.status === "missing") {
          blockers.push({ requirementId: requirement.id, field: resolution.field, status: "missing", detail: `Falta el dato "${resolution.field}" en el perfil de empresa.` });
        } else {
          blockers.push({ requirementId: requirement.id, field: resolution.field, status: "blocked", detail: resolution.detail });
        }
      }

      sections.push({ id: `sec-${requirement.id}`, requirementId: requirement.id, title: requirement.text, statements, blockers });
      globalBlockers.push(...blockers);
    }

    return { sections, blockers: globalBlockers };
  }

  private resolveMapping(
    companyId: string,
    mapping: RequirementFulfillmentMapping,
    asOfIso: string,
  ): FieldResolution<unknown> {
    switch (mapping.kind) {
      case "capability":
        return this.companyData.resolveCapability(companyId, mapping.refKey);
      case "experience":
        return this.companyData.resolveExperience(companyId, mapping.refKey);
      case "document":
        return this.companyData.resolveDocumentByType(companyId, mapping.refKey, asOfIso);
      case "signer":
        return this.companyData.resolveAuthorizedSigner(companyId, mapping.refKey);
      default:
        return { status: "missing", field: mapping.refKey };
    }
  }
}
