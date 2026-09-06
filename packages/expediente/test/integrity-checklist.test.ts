import { describe, expect, it } from "vitest";
import { IntegrityChecklist, type IntegrityChecklistInput } from "../src/integrity-checklist.js";
import { resetRequirementCounters, type RequirementItem } from "../src/requirement-matrix.js";

const ASOF = "2026-10-20T12:00:00-06:00";

function baseInput(overrides: Partial<IntegrityChecklistInput> = {}): IntegrityChecklistInput {
  return {
    files: [{ filename: "propuesta_tecnica.pdf", extension: "pdf", sizeBytes: 1000 }],
    formatLimits: { allowedExtensions: ["pdf", "xlsx"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 10 },
    requiredSignatures: [],
    requiredAnnexes: [],
    presentAnnexRefs: [],
    documentsToValidate: [],
    economicResult: null,
    crossDocumentTotals: [],
    ...overrides,
  };
}

describe("IntegrityChecklist — 7 dimensiones independientes (REQ-160)", () => {
  it("produce un resultado propio por cada una de las 7 dimensiones", () => {
    const report = new IntegrityChecklist().run(baseInput());
    const dimensions = report.items.map((i) => i.dimension).sort();
    expect(dimensions).toEqual(
      ["anexos_obligatorios", "calculos_economicos", "consistencia_cruzada", "firmas", "formatos", "limites", "vigencias"].sort(),
    );
  });

  it("marca 'formatos' en rojo ante una extensión no permitida", () => {
    const report = new IntegrityChecklist().run(
      baseInput({ files: [{ filename: "malware.exe", extension: "exe", sizeBytes: 100 }] }),
    );
    const formatos = report.items.find((i) => i.dimension === "formatos");
    expect(formatos?.status).toBe("rojo");
    expect(report.overallStatus).toBe("rojo");
  });

  it("marca 'limites' en rojo cuando un archivo excede el tamaño máximo o hay más archivos que espacios de carga", () => {
    const report = new IntegrityChecklist().run(
      baseInput({
        files: [{ filename: "grande.pdf", extension: "pdf", sizeBytes: 99_000_000 }],
        formatLimits: { allowedExtensions: ["pdf"], maxFileSizeBytes: 10_000_000, maxUploadSlots: 10 },
      }),
    );
    expect(report.items.find((i) => i.dimension === "limites")?.status).toBe("rojo");
  });

  it("marca 'firmas' en rojo mientras falte confirmación del usuario, y nunca la marca sola", () => {
    const report = new IntegrityChecklist().run(
      baseInput({ requiredSignatures: [{ role: "representante_legal", userConfirmedSigned: false }] }),
    );
    const firmas = report.items.find((i) => i.dimension === "firmas");
    expect(firmas?.status).toBe("rojo");
    expect(firmas?.detail).toContain("El sistema nunca firma");
  });

  it("marca 'firmas' en verde solo cuando el USUARIO confirmó la firma (el sistema no la genera)", () => {
    const report = new IntegrityChecklist().run(
      baseInput({ requiredSignatures: [{ role: "representante_legal", userConfirmedSigned: true }] }),
    );
    expect(report.items.find((i) => i.dimension === "firmas")?.status).toBe("verde");
  });

  it("A9: marca 'anexos_obligatorios' en rojo cuando falta un anexo obligatorio de la matriz", () => {
    resetRequirementCounters();
    const anexoObligatorio: RequirementItem = {
      id: "req-anexo-5",
      text: "Anexo 5 obligatorio",
      source: { documentId: "bases-v1", documentLabel: "Bases", page: 3 },
      obligatoriedad: "obligatorio",
      type: "anexo",
      responsibleRole: "licitador",
      deadline: null,
      requiredEvidence: ["anexo_5_firmado"],
      status: "pendiente",
      extractedBy: "rule",
      topicKey: "anexo_5",
    };
    const report = new IntegrityChecklist().run(
      baseInput({ requiredAnnexes: [anexoObligatorio], presentAnnexRefs: [] }),
    );
    const anexos = report.items.find((i) => i.dimension === "anexos_obligatorios");
    expect(anexos?.status).toBe("rojo");
    expect(report.overallStatus).toBe("rojo");

    const reportOk = new IntegrityChecklist().run(
      baseInput({ requiredAnnexes: [anexoObligatorio], presentAnnexRefs: ["anexo_5"] }),
    );
    expect(reportOk.items.find((i) => i.dimension === "anexos_obligatorios")?.status).toBe("verde");
  });

  it("A7: marca 'vigencias' en rojo cuando un documento vence antes de la fecha del acto", () => {
    const report = new IntegrityChecklist().run(
      baseInput({
        documentsToValidate: [
          {
            document: {
              id: "doc-1",
              companyId: "empresa-1",
              type: "opinion_32d",
              label: "Opinión 32-D",
              issuedAt: "2026-01-01T00:00:00-06:00",
              expiresAt: "2026-10-01T00:00:00-06:00",
              approvalStatus: "aprobado",
            },
            asOfIso: ASOF,
          },
        ],
      }),
    );
    expect(report.items.find((i) => i.dimension === "vigencias")?.status).toBe("rojo");
  });

  it("marca 'calculos_economicos' en rojo cuando no hay propuesta económica o tiene conceptos bloqueados", () => {
    const report = new IntegrityChecklist().run(baseInput({ economicResult: null }));
    expect(report.items.find((i) => i.dimension === "calculos_economicos")?.status).toBe("rojo");
  });

  it("marca 'consistencia_cruzada' en rojo cuando los totales entre documentos difieren", () => {
    const report = new IntegrityChecklist().run(
      baseInput({
        crossDocumentTotals: [
          { documentLabel: "carta", total: "9860.00" },
          { documentLabel: "anexo_economico", total: "9999.99" },
        ],
      }),
    );
    expect(report.items.find((i) => i.dimension === "consistencia_cruzada")?.status).toBe("rojo");
  });

  it("marca 'consistencia_cruzada' en verde cuando coinciden", () => {
    const report = new IntegrityChecklist().run(
      baseInput({
        crossDocumentTotals: [
          { documentLabel: "carta", total: "9860.00" },
          { documentLabel: "anexo_economico", total: "9860.00" },
        ],
      }),
    );
    expect(report.items.find((i) => i.dimension === "consistencia_cruzada")?.status).toBe("verde");
  });

  it("overallStatus es 'verde' solo si las 7 dimensiones son verdes", () => {
    const report = new IntegrityChecklist().run(
      baseInput({
        requiredSignatures: [{ role: "representante_legal", userConfirmedSigned: true }],
        economicResult: {
          lineItems: [],
          blockedLineItems: [],
          totals: { currency: "MXN", subtotal: "100.00", ivaRate: 0.16, iva: "16.00", total: "116.00", totalInWords: "SON: CIENTO DIECISEIS PESOS 00/100 M.N." },
          cartaText: "x",
          anexoText: "y",
        },
        crossDocumentTotals: [
          { documentLabel: "carta", total: "116.00" },
          { documentLabel: "anexo", total: "116.00" },
        ],
      }),
    );
    expect(report.overallStatus).toBe("verde");
  });
});
