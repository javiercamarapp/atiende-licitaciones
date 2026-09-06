import { beforeEach, describe, expect, it } from "vitest";
import {
  RequirementMatrixBuilder,
  RuleBasedExtractor,
  resetRequirementCounters,
  type TenderDocumentText,
} from "../src/requirement-matrix.js";

describe("RequirementMatrixBuilder (REQ-156)", () => {
  beforeEach(() => resetRequirementCounters());

  it("extrae los 7 campos de gestión exigidos por REQ-156 para cada ítem", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases de licitación",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [
        {
          page: 12,
          text: "El licitante deberá presentar la fianza de cumplimiento por el 10% del monto contratado, conforme a la cláusula 14.3. La entrega de proposiciones será a más tardar el 20 de octubre de 2026 a las 12:00 horas.",
        },
      ],
    };

    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items } = await builder.build([doc]);

    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.source.documentId).toBe("bases-v1");
      expect(item.source.page).toBe(12);
      expect(["obligatorio", "opcional", "condicional"]).toContain(item.obligatoriedad);
      expect(item.responsibleRole).toBeTruthy();
      expect(["pendiente", "en_progreso", "cumplido", "bloqueado", "no_evaluable"]).toContain(item.status);
      expect(Array.isArray(item.requiredEvidence)).toBe(true);
      // deadline puede ser null (no todos los requisitos tienen fecha propia),
      // pero el campo debe existir explícitamente en el esquema.
      expect(item).toHaveProperty("deadline");
    }

    const fianza = items.find((i) => i.text.includes("fianza"));
    expect(fianza?.source.clause).toContain("14.3");
    expect(fianza?.obligatoriedad).toBe("obligatorio");
    expect(fianza?.requiredEvidence).toContain("póliza_de_fianza");

    const plazo = items.find((i) => i.topicKey === "plazo_entrega_proposiciones");
    expect(plazo?.deadline).toBe("2026-10-20T12:00:00-06:00");
  });

  it("clasifica anexos y tipo económico/legal por palabra clave", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [
        { page: 3, text: "Es obligatorio presentar el Anexo 5 debidamente firmado." },
        { page: 4, text: "El licitante deberá presentar su cotización económica conforme al Anexo 6." },
        { page: 5, text: "Se requiere la opinión de cumplimiento 32-D vigente del SAT." },
      ],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items } = await builder.build([doc]);

    const anexo5 = items.find((i) => i.text.includes("Anexo 5"));
    expect(anexo5?.type).toBe("anexo");

    const sat = items.find((i) => i.text.includes("32-D"));
    expect(sat?.type).toBe("legal");
    expect(sat?.requiredEvidence).toContain("opinión_32d_sat");
  });

  it("no inventa fecha límite cuando el texto no trae una fecha inequívoca", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "El licitante deberá presentar carta de aceptación de condiciones." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items } = await builder.build([doc]);
    expect(items[0]?.deadline).toBeNull();
  });
});

describe("Detección de conflictos entre documentos (A6, REQ-166)", () => {
  beforeEach(() => resetRequirementCounters());

  it("genera un Conflict escalado cuando dos documentos fijan plazos distintos para el mismo tema, sin elegir ninguno en silencio", async () => {
    const bases: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases originales",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "La entrega de proposiciones será a más tardar el 20 de octubre de 2026 a las 12:00 horas." }],
    };
    const aclaracion: TenderDocumentText = {
      documentId: "acta-aclaraciones-1",
      documentLabel: "Acta de junta de aclaraciones 1",
      publishedAt: "2026-02-01T00:00:00-06:00",
      pages: [{ page: 1, text: "Se adelanta la entrega de proposiciones para el 15 de octubre de 2026 a las 10:00 horas." }],
    };

    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items, conflicts } = await builder.build([bases, aclaracion]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("deadline_mismatch");
    expect(conflicts[0].status).toBe("escalado");
    expect(conflicts[0].items).toHaveLength(2);
    expect(new Set(conflicts[0].items.map((i) => i.source.documentId))).toEqual(new Set(["bases-v1", "acta-aclaraciones-1"]));

    // Ningún ítem del conflicto queda como si tuviera un plazo "ganador":
    // ambos se marcan bloqueados hasta escalado humano.
    const conflictingItems = items.filter((i) => i.topicKey === "plazo_entrega_proposiciones");
    expect(conflictingItems).toHaveLength(2);
    for (const item of conflictingItems) {
      expect(item.status).toBe("bloqueado");
    }
  });

  it("no genera conflicto cuando los documentos coinciden en el mismo plazo", async () => {
    const bases: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "La entrega de proposiciones será a más tardar el 20 de octubre de 2026 a las 12:00 horas." }],
    };
    const anexo: TenderDocumentText = {
      documentId: "anexo-tecnico",
      documentLabel: "Anexo técnico",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "Se confirma que la entrega de proposiciones será a más tardar el 20 de octubre de 2026 a las 12:00 horas." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { conflicts } = await builder.build([bases, anexo]);
    expect(conflicts).toHaveLength(0);
  });
});

describe("EX-EXP-06: extractDeadline reconoce DD/MM/AAAA, DD-MM-AAAA y 'del AAAA' (REQ-156/REQ-166)", () => {
  beforeEach(() => resetRequirementCounters());

  it("reconoce 'DD/MM/AAAA' (acto de presentación) y le asigna topicKey", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "El acto de presentación de proposiciones se llevará a cabo el 15/10/2026." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items } = await builder.build([doc]);
    const item = items.find((i) => i.text.includes("15/10/2026"));
    expect(item).toBeDefined();
    expect(item?.deadline).toBe("2026-10-15T23:59:59-06:00");
    expect(item?.topicKey).toBe("plazo_entrega_proposiciones");
  });

  it("reconoce 'DD-MM-AAAA' con guiones", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "La junta de aclaraciones se realizará el 25-09-2026." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items } = await builder.build([doc]);
    const item = items.find((i) => i.text.includes("25-09-2026"));
    expect(item).toBeDefined();
    expect(item?.deadline).toBe("2026-09-25T23:59:59-06:00");
    expect(item?.topicKey).toBe("plazo_junta_aclaraciones");
  });

  it("reconoce '... del AAAA' (con 'del' en vez de 'de')", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "La junta de aclaraciones se llevará a cabo el 25 de septiembre del 2026." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items } = await builder.build([doc]);
    const item = items.find((i) => i.text.includes("septiembre del 2026"));
    expect(item).toBeDefined();
    expect(item?.deadline).toBe("2026-09-25T23:59:59-06:00");
    expect(item?.topicKey).toBe("plazo_junta_aclaraciones");
  });

  it("reproducción íntegra de la auditoría: un conflicto real de plazos SÍ se detecta aunque las bases y el acta de aclaraciones usen formatos de fecha distintos", async () => {
    const bases: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases originales",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "La entrega de proposiciones será a más tardar el 20 de octubre de 2026 a las 12:00 horas." }],
    };
    const aclaracion: TenderDocumentText = {
      documentId: "acta-aclaraciones-1",
      documentLabel: "Acta de junta de aclaraciones 1",
      publishedAt: "2026-02-01T00:00:00-06:00",
      pages: [{ page: 1, text: "Se adelanta el acto de presentación de proposiciones para el 15/10/2026." }],
    };

    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { conflicts } = await builder.build([bases, aclaracion]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe("deadline_mismatch");
    expect(conflicts[0].topicKey).toBe("plazo_entrega_proposiciones");
    expect(conflicts[0].status).toBe("escalado");
  });
});

/**
 * EX-EXP-15 (reverificación ronda 1, MEDIA, asociado a EX-EXP-06): el
 * patrón numérico de `extractDeadline` SIEMPRE asumía DD/MM sin marcar
 * ambigüedad ni bajar `confidence` cuando día y mes eran ambos ≤12 (p. ej.
 * "05/09/2026" podría razonablemente ser 5-sep o 9-may) — contradice la
 * filosofía declarada del extractor ("ante ambigüedad, clasifica... antes
 * que inventar un valor en silencio"). La interpretación por defecto sigue
 * siendo DD/MM (correcta para licitaciones mexicanas); solo cambia la
 * `confidence` para que un revisor humano lo confirme.
 */
describe("EX-EXP-15: fecha numérica ambigua (día y mes ambos ≤12) baja confidence, sin cambiar la interpretación DD/MM por defecto", () => {
  beforeEach(() => resetRequirementCounters());

  it("'05/09/2026' (ambas lecturas posibles: 5-sep o 9-may) tiene confidence menor que una fecha inequívoca", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "El acto de presentación de proposiciones se llevará a cabo el 05/09/2026." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items } = await builder.build([doc]);
    const item = items.find((i) => i.text.includes("05/09/2026"));
    expect(item).toBeDefined();
    // La interpretación sigue siendo DD/MM (5 de septiembre) — NO cambia.
    expect(item?.deadline).toBe("2026-09-05T23:59:59-06:00");
    expect(item?.confidence).toBeLessThan(0.7);
  });

  it("'25/10/2026' (día > 12, inequívoca) mantiene la confidence original de 0.7", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "El acto de presentación de proposiciones se llevará a cabo el 25/10/2026." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items } = await builder.build([doc]);
    const item = items.find((i) => i.text.includes("25/10/2026"));
    expect(item).toBeDefined();
    expect(item?.confidence).toBe(0.7);
  });

  it("'05/05/2026' (día === mes: ambas lecturas dan la MISMA fecha) NO se marca como ambigua", async () => {
    const doc: TenderDocumentText = {
      documentId: "bases-v1",
      documentLabel: "Bases",
      publishedAt: "2026-01-01T00:00:00-06:00",
      pages: [{ page: 1, text: "El acto de presentación de proposiciones se llevará a cabo el 05/05/2026." }],
    };
    const builder = new RequirementMatrixBuilder([new RuleBasedExtractor()]);
    const { items } = await builder.build([doc]);
    const item = items.find((i) => i.text.includes("05/05/2026"));
    expect(item).toBeDefined();
    expect(item?.confidence).toBe(0.7);
  });
});
