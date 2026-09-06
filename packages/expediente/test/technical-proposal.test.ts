import { beforeEach, describe, expect, it } from "vitest";
import { CompanyDataService, InMemoryCompanyDataResolver } from "../src/company-data.js";
import { TechnicalProposalBuilder } from "../src/technical-proposal.js";
import { RequirementMatrixBuilder, RuleBasedExtractor, resetRequirementCounters, type TenderDocumentText } from "../src/requirement-matrix.js";

const ASOF = "2026-10-20T12:00:00-06:00";
const COMPANY_ID = "empresa-1";

/**
 * EX-EXP-03 (CRÍTICA, auditoría ronda 1): un requisito con
 * `obligatoriedad === "obligatorio"` sin `requiredEvidence` reconocida por
 * el extractor (p. ej. la manifestación de no estar en los supuestos de los
 * arts. 50/60 de la LAASSP, o la declaración de integridad — cláusulas
 * obligatorias reales que NO son fianza/garantía/32-D/acta
 * constitutiva/poder notarial/anexo) desaparecía por completo del pipeline:
 * sin sección, sin bloqueo, sin rastro. Debe quedar como sección
 * "PENDIENTE" con un `SectionBlocker` explícito — nunca omitido en
 * silencio. El "skip silencioso" se reserva solo para requisitos
 * verdaderamente procedimentales (opcionales/condicionales sin evidencia).
 */
describe("TechnicalProposalBuilder — EX-EXP-03: requisito obligatorio sin evidencia mapeable queda PENDIENTE (REQ-158)", () => {
  beforeEach(() => resetRequirementCounters());

  function emptyCompanyService() {
    return new CompanyDataService(new InMemoryCompanyDataResolver({}));
  }

  it("arts. 50/60 LAASSP: manifestación obligatoria sin evidencia reconocida genera sección PENDIENTE con SectionBlocker, no desaparece", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases de licitación",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [
        {
          page: 7,
          text: "El licitante deberá manifestar bajo protesta de decir verdad que no se encuentra en los supuestos de los artículos 50 y 60 de la Ley de Adquisiciones, Arrendamientos y Servicios del Sector Público.",
        },
      ],
    };
    const matrixBuilder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items: requirements } = await matrixBuilder.build([doc]);

    const art5060 = requirements.find((r) => r.text.includes("artículos 50 y 60"));
    expect(art5060).toBeDefined();
    expect(art5060?.obligatoriedad).toBe("obligatorio");
    expect(art5060?.requiredEvidence).toHaveLength(0); // el extractor no reconoce evidencia para esta cláusula

    const technical = new TechnicalProposalBuilder(emptyCompanyService()).build(COMPANY_ID, requirements, [], ASOF);

    // El requisito NUNCA desaparece: debe existir una sección para él.
    const section = technical.sections.find((s) => s.requirementId === art5060!.id);
    expect(section).toBeDefined();
    expect(section!.title).toContain("PENDIENTE");
    expect(section!.statements).toHaveLength(0);
    expect(section!.blockers).toHaveLength(1);
    expect(section!.blockers[0].status).toBe("missing");
    expect(section!.blockers[0].field).toBe("evidencia_no_mapeable");

    // Y se propaga como bloqueo global: el expediente no puede considerarse completo.
    expect(technical.blockers.some((b) => b.requirementId === art5060!.id && b.field === "evidencia_no_mapeable")).toBe(true);
  });

  it("declaración de integridad (art. 29 fracc. IX) obligatoria sin evidencia también queda PENDIENTE, no se pierde", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases de licitación",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 8, text: "El licitante deberá presentar declaración de integridad conforme al artículo 29 fracción IX." }],
    };
    const matrixBuilder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items: requirements } = await matrixBuilder.build([doc]);

    const integridad = requirements.find((r) => r.text.includes("declaración de integridad"));
    expect(integridad).toBeDefined();
    expect(integridad?.obligatoriedad).toBe("obligatorio");
    expect(integridad?.requiredEvidence).toHaveLength(0);

    const technical = new TechnicalProposalBuilder(emptyCompanyService()).build(COMPANY_ID, requirements, [], ASOF);
    const section = technical.sections.find((s) => s.requirementId === integridad!.id);
    expect(section).toBeDefined();
    expect(section!.blockers[0].field).toBe("evidencia_no_mapeable");
  });

  it("un requisito procedimental (opcional/condicional) sin evidencia sigue omitiéndose en silencio — no es una regresión de REQ-158", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases de licitación",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "La entrega de proposiciones será a más tardar el 20 de octubre de 2026 a las 12:00 horas." }],
    };
    const matrixBuilder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items: requirements } = await matrixBuilder.build([doc]);

    const plazo = requirements.find((r) => r.topicKey === "plazo_entrega_proposiciones");
    expect(plazo).toBeDefined();
    expect(plazo?.obligatoriedad).not.toBe("obligatorio"); // anuncio de plazo, no un requisito obligatorio léxico
    expect(plazo?.requiredEvidence).toHaveLength(0);

    const technical = new TechnicalProposalBuilder(emptyCompanyService()).build(COMPANY_ID, requirements, [], ASOF);
    expect(technical.sections.find((s) => s.requirementId === plazo!.id)).toBeUndefined();
    expect(technical.blockers.some((b) => b.requirementId === plazo!.id)).toBe(false);
  });

  it("2 de 3 requisitos obligatorios de bases LAASSP realistas ya no se pierden silenciosamente (reproducción íntegra de la auditoría)", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases de licitación",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [
        {
          page: 1,
          text: [
            "El licitante deberá manifestar bajo protesta de decir verdad que no se encuentra en los supuestos de los artículos 50 y 60 de la LAASSP.",
            "El licitante deberá presentar escrito en el que manifieste su nacionalidad mexicana conforme al Anexo 5.",
            "El licitante deberá presentar declaración de integridad conforme al artículo 29 fracción IX.",
          ].join(" "),
        },
      ],
    };
    const matrixBuilder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items: requirements } = await matrixBuilder.build([doc]);
    const obligatorios = requirements.filter((r) => r.obligatoriedad === "obligatorio");
    expect(obligatorios.length).toBeGreaterThanOrEqual(3);

    const technical = new TechnicalProposalBuilder(emptyCompanyService()).build(COMPANY_ID, requirements, [], ASOF);

    // Ningún requisito obligatorio queda sin sección ni sin bloqueo.
    for (const req of obligatorios) {
      const section = technical.sections.find((s) => s.requirementId === req.id);
      expect(section, `requisito obligatorio sin sección: "${req.text}"`).toBeDefined();
      expect(section!.blockers.length + section!.statements.length).toBeGreaterThan(0);
    }
  });
});
