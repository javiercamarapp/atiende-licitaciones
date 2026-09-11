import { beforeEach, describe, expect, it } from "vitest";
import { RequirementMatrixBuilder, RuleBasedExtractor, resetRequirementCounters, type Conflict, type RequirementItem, type TenderDocumentText } from "../src/requirement-matrix.js";
import { generateJuntaQuestions, resetJuntaQuestionCounters, type GenerateJuntaQuestionsInput } from "../src/junta-questions.js";

const JUNTA_AT = "2026-11-01T10:00:00-06:00"; // junta de aclaraciones

describe("generateJuntaQuestions (REQ-041: preguntas de junta con sources)", () => {
  beforeEach(() => {
    resetRequirementCounters();
    resetJuntaQuestionCounters();
  });

  it("genera una pregunta fundada (cita + alternativa) cuando dos documentos fijan plazos distintos, citando AMBAS fuentes reales", async () => {
    const bases: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases originales",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 3, text: "La entrega de proposiciones será a más tardar el 20 de octubre de 2026 a las 12:00 horas, conforme a la cláusula 5.1." }],
    };
    const aclaracion: TenderDocumentText = {
      documentId: "acta-aclaraciones-1",
      documentLabel: "Acta de junta de aclaraciones 1",
      publishedAt: "2026-02-01T00:00:00-06:00",
      pages: [{ page: 1, text: "Se adelanta la entrega de proposiciones para el 15 de octubre de 2026 a las 10:00 horas." }],
    };

    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items, conflicts } = await builder.build([bases, aclaracion]);
    expect(conflicts).toHaveLength(1); // fixture ya verificada en requirement-matrix.test.ts

    const result = generateJuntaQuestions({ items, conflicts, juntaAclaracionesAt: JUNTA_AT });

    expect(result.questions).toHaveLength(1);
    const q = result.questions[0];
    expect(q.reason).toBe("conflicto_plazo");
    expect(q.sources.length).toBeGreaterThanOrEqual(2);
    // Cada fuente es EXACTAMENTE trazable a un documento/página real de la fixture.
    const docIds = new Set(q.sources.map((s) => s.documentId));
    expect(docIds).toEqual(new Set(["bases-v1", "acta-aclaraciones-1"]));
    for (const s of q.sources) {
      expect(s.page).toBeGreaterThan(0);
      expect(s.quote.length).toBeGreaterThan(0);
    }
    // La cita textual literal de las bases debe aparecer tal cual, sin alterar.
    expect(q.sources.find((s) => s.documentId === "bases-v1")?.quote).toContain("20 de octubre de 2026");
    // Numeral: se toma del único ítem que sí trae cláusula citada (nunca se inventa el de la otra fuente).
    expect(q.numeral).toBe("cláusula 5.1.");
    // Alternativa propuesta debe mencionar ambas fechas en disputa, nunca elegir una.
    expect(q.alternativaPropuesta).toMatch(/20 de octubre/);
    expect(q.alternativaPropuesta).toMatch(/15 de octubre/);
    expect(result.rejected).toHaveLength(0);
  });

  it("genera una pregunta fundada cuando dos documentos contradicen la obligatoriedad de un requisito", async () => {
    const bases: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 4, text: "El licitante deberá presentar la fianza de cumplimiento por el 10% del monto contratado." }],
    };
    const anexo: TenderDocumentText = {
      documentId: "anexo-1",
      documentLabel: "Anexo 1",
      publishedAt: "2026-01-05T00:00:00-06:00",
      pages: [{ page: 2, text: "El licitante podrá presentar la fianza de cumplimiento de manera opcional según su capacidad financiera." }],
    };

    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items, conflicts } = await builder.build([bases, anexo]);
    const obligConflict = conflicts.find((c) => c.kind === "obligatoriedad_mismatch");
    expect(obligConflict).toBeTruthy();

    const result = generateJuntaQuestions({ items, conflicts, juntaAclaracionesAt: JUNTA_AT });
    const q = result.questions.find((x) => x.reason === "conflicto_obligatoriedad");
    expect(q).toBeTruthy();
    expect(q!.sources.length).toBeGreaterThanOrEqual(2);
    expect(q!.question).toMatch(/obligatorio/);
    expect(q!.question).toMatch(/opcional/);
  });

  it("genera una pregunta fundada para una fecha numérica ambigua (confianza baja) que NO forma parte de ningún conflicto", async () => {
    const bases: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 7, text: "La junta de aclaraciones se llevará a cabo el 05/09/2026 a las 09:00 horas." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items, conflicts } = await builder.build([bases]);
    expect(conflicts).toHaveLength(0);
    const ambiguousItem = items.find((i) => i.confidence === 0.5);
    expect(ambiguousItem).toBeTruthy();

    const result = generateJuntaQuestions({ items, conflicts, juntaAclaracionesAt: JUNTA_AT });
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].reason).toBe("fecha_ambigua");
    expect(result.questions[0].sources).toHaveLength(1);
    expect(result.questions[0].sources[0].documentId).toBe("bases-v1");
    expect(result.questions[0].sources[0].quote).toContain("05/09/2026");
  });

  it("no genera ninguna pregunta cuando no hay conflictos ni ambigüedades -- nunca fabrica preguntas de la nada", async () => {
    const bases: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "El licitante deberá presentar la fianza de cumplimiento conforme a la cláusula 5." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items, conflicts } = await builder.build([bases]);

    const result = generateJuntaQuestions({ items, conflicts, juntaAclaracionesAt: JUNTA_AT });
    expect(result.questions).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });

  it("calcula correctamente la ventana de 24h antes de la junta (REQ-041)", async () => {
    const bases: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "sin requisitos relevantes aquí" }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items, conflicts } = await builder.build([bases]);

    const dentro = generateJuntaQuestions({ items, conflicts, juntaAclaracionesAt: JUNTA_AT, asOf: "2026-10-30T09:00:00-06:00" });
    expect(dentro.window.questionsDueAt).toBe(new Date("2026-10-31T10:00:00-06:00").toISOString());
    expect(dentro.window.isWithinWindow).toBe(true);
    expect(dentro.window.hoursUntilDue).toBeGreaterThan(0);

    const fuera = generateJuntaQuestions({ items, conflicts, juntaAclaracionesAt: JUNTA_AT, asOf: "2026-10-31T12:00:00-06:00" });
    expect(fuera.window.isWithinWindow).toBe(false);
    expect(fuera.window.hoursUntilDue).toBeLessThan(0);
  });

  it("rechaza fechas inválidas de junta/asOf en vez de calcular una ventana con NaN", async () => {
    expect(() => generateJuntaQuestions({ items: [], conflicts: [], juntaAclaracionesAt: "no-es-una-fecha" })).toThrow();
    expect(() => generateJuntaQuestions({ items: [], conflicts: [], juntaAclaracionesAt: JUNTA_AT, asOf: "tampoco" })).toThrow();
  });

  // ---------------------------------------------------------------------
  // Adversarial: nunca fabricar una fuente ni emitir una pregunta sin ella.
  // ---------------------------------------------------------------------
  describe("Guardrail adversarial: 0 preguntas sin fuente verificable", () => {
    function fakeItem(overrides: Partial<RequirementItem>): RequirementItem {
      return {
        id: overrides.id ?? "req-fake",
        text: overrides.text ?? "texto de prueba",
        source: { documentId: "doc-1", documentLabel: "Doc 1", page: 1, clause: undefined, ...overrides.source },
        obligatoriedad: overrides.obligatoriedad ?? "obligatorio",
        type: overrides.type ?? "administrativo",
        responsibleRole: overrides.responsibleRole ?? "licitador",
        deadline: overrides.deadline ?? "2026-10-20T12:00:00-06:00",
        requiredEvidence: overrides.requiredEvidence ?? [],
        status: overrides.status ?? "pendiente",
        extractedBy: overrides.extractedBy ?? "rule",
        confidence: overrides.confidence,
        topicKey: overrides.topicKey ?? "tema_x",
      };
    }

    it("un Conflict con página inválida (0) en AMBOS ítems se descarta por completo -- nunca se emite con un número fabricado", () => {
      const itemA = fakeItem({ id: "a", source: { documentId: "doc-a", documentLabel: "A", page: 0 }, deadline: "2026-10-20T12:00:00-06:00" });
      const itemB = fakeItem({ id: "b", source: { documentId: "doc-b", documentLabel: "B", page: -3 }, deadline: "2026-10-21T12:00:00-06:00" });
      const conflict: Conflict = { id: "c1", kind: "deadline_mismatch", topicKey: "tema_x", description: "fixture adversarial", items: [itemA, itemB], status: "escalado" };

      const result = generateJuntaQuestions({ items: [itemA, itemB], conflicts: [conflict], juntaAclaracionesAt: JUNTA_AT });
      expect(result.questions).toHaveLength(0);
      expect(result.rejected.some((r) => r.reason === "sin_fuente_verificable")).toBe(true);
    });

    it("un Conflict con documentId vacío en un ítem se descarta ese ítem (nunca lo cita) pero SÍ puede generar pregunta con el otro ítem válido", () => {
      const itemA = fakeItem({ id: "a", source: { documentId: "", documentLabel: "A", page: 1 }, deadline: "2026-10-20T12:00:00-06:00" });
      const itemB = fakeItem({ id: "b", source: { documentId: "doc-b", documentLabel: "B", page: 2 }, deadline: "2026-10-21T12:00:00-06:00" });
      const conflict: Conflict = { id: "c2", kind: "deadline_mismatch", topicKey: "tema_x", description: "fixture adversarial", items: [itemA, itemB], status: "escalado" };

      const result = generateJuntaQuestions({ items: [itemA, itemB], conflicts: [conflict], juntaAclaracionesAt: JUNTA_AT });
      expect(result.questions).toHaveLength(1);
      const q = result.questions[0];
      expect(q.sources).toHaveLength(1);
      expect(q.sources[0].documentId).toBe("doc-b");
      // El texto NUNCA menciona la fecha del ítem sin fuente verificable (2026-10-20).
      expect(q.question).not.toContain("20 de octubre");
      expect(q.alternativaPropuesta).not.toContain("20 de octubre");
    });

    it("un ítem de baja confianza con texto vacío se descarta -- nunca genera una pregunta con cita fabricada", () => {
      const item = fakeItem({ id: "z", text: "", confidence: 0.3, source: { documentId: "doc-z", documentLabel: "Z", page: 1 } });
      const result = generateJuntaQuestions({ items: [item], conflicts: [], juntaAclaracionesAt: JUNTA_AT });
      expect(result.questions).toHaveLength(0);
      expect(result.rejected.some((r) => r.reason === "sin_fuente_verificable")).toBe(true);
    });

    it("propiedad: en un lote combinado de fixtures válidas y adversariales, el 100% de las preguntas devueltas tiene al menos 1 fuente verificable no vacía", () => {
      const good1 = fakeItem({ id: "g1", source: { documentId: "doc-1", documentLabel: "Doc 1", page: 3 }, deadline: "2026-10-20T12:00:00-06:00" });
      const good2 = fakeItem({ id: "g2", source: { documentId: "doc-2", documentLabel: "Doc 2", page: 5 }, deadline: "2026-10-25T12:00:00-06:00" });
      const conflictGood: Conflict = { id: "cg", kind: "deadline_mismatch", topicKey: "tema_a", description: "d", items: [good1, good2], status: "escalado" };

      const bad1 = fakeItem({ id: "b1", source: { documentId: "doc-3", documentLabel: "", page: 1 } }); // documentLabel vacío -> inválida
      const bad2 = fakeItem({ id: "b2", source: { documentId: "doc-4", documentLabel: "Doc 4", page: 0 } }); // page inválida
      const conflictBad: Conflict = { id: "cb", kind: "obligatoriedad_mismatch", topicKey: "tema_b", description: "d", items: [bad1, bad2], status: "escalado" };

      const lowConfAmbiguous = fakeItem({ id: "amb", confidence: 0.4, source: { documentId: "doc-5", documentLabel: "Doc 5", page: 9 }, topicKey: "tema_c" });

      const input: GenerateJuntaQuestionsInput = {
        items: [good1, good2, bad1, bad2, lowConfAmbiguous],
        conflicts: [conflictGood, conflictBad],
        juntaAclaracionesAt: JUNTA_AT,
      };
      const result = generateJuntaQuestions(input);

      expect(result.questions.length).toBeGreaterThan(0);
      for (const q of result.questions) {
        expect(q.sources.length).toBeGreaterThan(0);
        for (const s of q.sources) {
          expect(s.documentId.length).toBeGreaterThan(0);
          expect(s.page).toBeGreaterThan(0);
          expect(s.quote.length).toBeGreaterThan(0);
        }
      }
      // El conflicto totalmente inválido (cb) se rechazó explícitamente, no en silencio.
      expect(result.rejected.some((r) => r.reason === "sin_fuente_verificable" && r.detail.includes("cb"))).toBe(true);
    });
  });
});
