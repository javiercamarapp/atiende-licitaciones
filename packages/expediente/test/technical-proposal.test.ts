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

  it("un requisito condicional que el llamador declara EXPLÍCITAMENTE como no aplicable (anuncio de plazo) genera una sección VISIBLE 'NO APLICA', sin bloqueos ni afirmaciones (EX-EXP-19)", async () => {
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
    expect(plazo?.obligatoriedad).toBe("condicional"); // anuncio de plazo, no un requisito obligatorio léxico
    expect(plazo?.requiredEvidence).toHaveLength(0);

    // EX-EXP-03/EX-EXP-12: el skip silencioso ya NO se infiere solo de
    // `obligatoriedad === "condicional"` — el llamador debe declarar
    // EXPLÍCITAMENTE que este condicional no aplica al caso concreto (un
    // anuncio de plazo genuinamente procedimental, no una obligación
    // sustantiva del licitante).
    // EX-EXP-19 (reverificación ronda 2): además, esa omisión YA NO
    // desaparece sin rastro — genera una sección visible "NO APLICA" con el
    // motivo, sin bloqueos ni afirmaciones, para que un auditor/UI pueda ver
    // QUÉ se omitió y POR QUÉ.
    const technical = new TechnicalProposalBuilder(emptyCompanyService()).build(COMPANY_ID, requirements, [], ASOF, {
      [plazo!.id]: false,
    });
    const section = technical.sections.find((s) => s.requirementId === plazo!.id);
    expect(section).toBeDefined();
    expect(section!.title).toContain("NO APLICA");
    expect(section!.title).toContain("evaluada falsa");
    expect(section!.statements).toHaveLength(0);
    expect(section!.blockers).toHaveLength(0);
    expect(technical.blockers.some((b) => b.requirementId === plazo!.id)).toBe(false);
  });

  describe("EX-EXP-03/EX-EXP-12: obligatoriedad 'condicional' ya NO se agrupa ciegamente con 'opcional'", () => {
    async function buildPlazoRequirement() {
      const doc: TenderDocumentText = {
        documentId: "bases-v1",
        documentLabel: "Bases de licitación",
        publishedAt: "2026-01-01T00:00:00-06:00",
        pages: [{ page: 1, text: "La entrega de proposiciones será a más tardar el 20 de octubre de 2026 a las 12:00 horas." }],
      };
      const matrixBuilder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
      const { items: requirements } = await matrixBuilder.build([doc]);
      const plazo = requirements.find((r) => r.topicKey === "plazo_entrega_proposiciones")!;
      expect(plazo.obligatoriedad).toBe("condicional");
      return { requirements, plazo };
    }

    it("condición NO evaluada (llamador no declaró nada): fail-closed, genera PENDIENTE con bloqueo 'condicion_no_evaluable', nunca desaparece", async () => {
      const { requirements, plazo } = await buildPlazoRequirement();
      const technical = new TechnicalProposalBuilder(emptyCompanyService()).build(COMPANY_ID, requirements, [], ASOF);
      const section = technical.sections.find((s) => s.requirementId === plazo.id);
      expect(section).toBeDefined();
      expect(section!.title).toContain("PENDIENTE");
      expect(section!.blockers).toHaveLength(1);
      expect(section!.blockers[0].field).toBe("condicion_no_evaluable");
      expect(technical.blockers.some((b) => b.requirementId === plazo.id && b.field === "condicion_no_evaluable")).toBe(true);
    });

    it("condición evaluada como VERDADERA (aplica al caso concreto): se trata como obligatorio, PENDIENTE con bloqueo 'evidencia_no_mapeable'", async () => {
      const { requirements, plazo } = await buildPlazoRequirement();
      const technical = new TechnicalProposalBuilder(emptyCompanyService()).build(COMPANY_ID, requirements, [], ASOF, {
        [plazo.id]: true,
      });
      const section = technical.sections.find((s) => s.requirementId === plazo.id);
      expect(section).toBeDefined();
      expect(section!.title).toContain("PENDIENTE");
      expect(section!.blockers[0].field).toBe("evidencia_no_mapeable");
    });

    it("condición evaluada como FALSA (no aplica al caso concreto): procedimental real, sección VISIBLE 'NO APLICA' sin bloqueos (EX-EXP-19)", async () => {
      const { requirements, plazo } = await buildPlazoRequirement();
      const technical = new TechnicalProposalBuilder(emptyCompanyService()).build(COMPANY_ID, requirements, [], ASOF, {
        [plazo.id]: false,
      });
      const section = technical.sections.find((s) => s.requirementId === plazo.id);
      expect(section).toBeDefined();
      expect(section!.title).toContain("NO APLICA");
      expect(section!.blockers).toHaveLength(0);
      expect(section!.statements).toHaveLength(0);
      expect(technical.blockers.some((b) => b.requirementId === plazo.id)).toBe(false);
    });
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
