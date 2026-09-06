import { beforeEach, describe, expect, it } from "vitest";
import { FakeLlmExtractorClient, LlmRequirementExtractor } from "../src/llm/extractor.js";
import { RequirementMatrixBuilder, RuleBasedExtractor, resetRequirementCounters, type TenderDocumentText } from "../src/requirement-matrix.js";

describe("Hook de extractor LLM (RequirementMatrixBuilder combinando reglas + LLM)", () => {
  beforeEach(() => resetRequirementCounters());

  it("combina el extractor determinista con un extractor LLM (falso, determinista en pruebas) sobre el mismo documento", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 7, text: "El licitante deberá presentar fianza de cumplimiento conforme a la cláusula 14." }],
    };

    const fakeLlmClient = new FakeLlmExtractorClient({
      "bases-v1": [
        {
          text: "El proveedor demostrará experiencia mínima de 5 años en el ramo mediante narrativa libre no capturada por reglas.",
          page: 9,
          obligatoriedad: "obligatorio",
          type: "tecnico",
          responsibleRole: "licitador",
          deadline: null,
          requiredEvidence: ["carta_experiencia"],
          confidence: 0.62,
          topicKey: "experiencia_minima",
        },
      ],
    });

    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor(), new LlmRequirementExtractor(fakeLlmClient)]);
    const { items } = await builder.build([doc]);

    const ruleItem = items.find((i) => i.extractedBy === "rule");
    const llmItem = items.find((i) => i.extractedBy === "llm");

    expect(ruleItem).toBeDefined();
    expect(llmItem).toBeDefined();
    expect(llmItem?.source.page).toBe(9);
    expect(llmItem?.requiredEvidence).toContain("carta_experiencia");
    expect(llmItem?.confidence).toBe(0.62);
  });

  it("el extractor LLM falso es determinista: misma entrada produce siempre los mismos candidatos (sin llamadas de red)", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "texto irrelevante" }],
    };
    const client = new FakeLlmExtractorClient({
      "bases-v1": [
        {
          text: "requisito x",
          page: 1,
          obligatoriedad: "condicional",
          type: "administrativo",
          responsibleRole: "licitador",
          deadline: null,
          requiredEvidence: [],
          confidence: 0.5,
        },
      ],
    });
    const r1 = await client.extractCandidates(doc);
    const r2 = await client.extractCandidates(doc);
    expect(r1).toEqual(r2);
  });
});
