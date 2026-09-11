import { describe, expect, it } from "vitest";
import { runAuditGates, type AuditInput } from "../../src/audit/gates.js";

/** Insumo "limpio": los 5 gates deben pasar sin ningún finding. */
function cleanInput(): AuditInput {
  return {
    packageId: "pkg-1",
    organizationId: "org-1",
    complianceMatrix: [
      { id: "req-1", obligatoriedad: "obligatorio", status: "cumplido" },
      { id: "req-2", obligatoriedad: "opcional", status: "pendiente" },
    ],
    hasUnresolvedConflicts: false,
    claims: [{ id: "claim-1", text: "Contamos con certificación ISO 9001 vigente.", sourceDocIds: ["doc-cert-iso"] }],
    knownEvidenceDocIds: ["doc-cert-iso"],
    economicLineItems: [
      { concept: "instalacion", quantity: 2, unitPriceCents: 10_000n, subtotalCents: 20_000n },
      { concept: "mantenimiento", quantity: 12, unitPriceCents: 5_000n, subtotalCents: 60_000n },
    ],
    economicTotals: {
      subtotalCents: 80_000n,
      ivaRate: 0.16,
      ivaCents: 12_800n,
      totalCents: 92_800n,
    },
    requiredSections: ["tecnica", "economica", "legal"],
    presentSections: ["tecnica", "economica", "legal"],
    technicalCommitmentConcepts: ["instalacion", "mantenimiento"],
  };
}

describe("runAuditGates — caso limpio (sin bloqueos)", () => {
  it("los 5 gates pasan y no hay findings", () => {
    const gates = runAuditGates(cleanInput());
    expect(gates).toHaveLength(5);
    for (const gate of gates) {
      expect(gate.passed).toBe(true);
      expect(gate.findings).toEqual([]);
    }
  });

  it("siempre corre los 5 gates en el orden fijo documentado", () => {
    const gates = runAuditGates(cleanInput());
    expect(gates.map((g) => g.gate)).toEqual([
      "matriz_completa",
      "citas_evidencia_real",
      "consistencia_numerica",
      "formato",
      "coherencia_tecnica_economica",
    ]);
  });
});

describe("gate: matriz_completa", () => {
  it("bloquea si un requisito obligatorio no está cumplido", () => {
    const input = cleanInput();
    input.complianceMatrix = [{ id: "req-1", obligatoriedad: "obligatorio", status: "pendiente" }];
    const [gate] = runAuditGates(input);
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("requisito_obligatorio_incompleto");
  });

  it("bloquea si la matriz está vacía", () => {
    const input = cleanInput();
    input.complianceMatrix = [];
    const [gate] = runAuditGates(input);
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("matriz_vacia");
  });

  it("bloquea si hay conflictos sin resolver aunque todo lo demás esté cumplido", () => {
    const input = cleanInput();
    input.hasUnresolvedConflicts = true;
    const [gate] = runAuditGates(input);
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("conflictos_sin_resolver");
  });

  it("no bloquea por un requisito opcional/condicional sin cumplir", () => {
    const input = cleanInput();
    input.complianceMatrix = [{ id: "req-1", obligatoriedad: "condicional", status: "pendiente" }];
    const [gate] = runAuditGates(input);
    expect(gate.passed).toBe(true);
  });
});

describe("gate: citas_evidencia_real (adversarial anti-fabricación)", () => {
  it("bloquea un claim sin ninguna fuente", () => {
    const input = cleanInput();
    input.claims = [{ id: "claim-x", text: "Tenemos 10 años de experiencia.", sourceDocIds: [] }];
    const [, gate] = runAuditGates(input);
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("claim_sin_fuente");
  });

  it("bloquea una cita a un documento de evidencia que NO existe (fuente fabricada/alucinada)", () => {
    const input = cleanInput();
    input.claims = [{ id: "claim-x", text: "Certificación XYZ vigente.", sourceDocIds: ["doc-que-no-existe"] }];
    // knownEvidenceDocIds sigue siendo solo ["doc-cert-iso"]: la cita apunta a una fuente inexistente.
    const [, gate] = runAuditGates(input);
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("cita_evidencia_inexistente");
  });

  it("pasa cuando todas las citas apuntan a evidencia real conocida", () => {
    const [, gate] = runAuditGates(cleanInput());
    expect(gate.passed).toBe(true);
  });
});

describe("gate: consistencia_numerica", () => {
  it("bloquea si faltan los totales económicos (nunca se asume $0)", () => {
    const input = cleanInput();
    input.economicTotals = null;
    const gates = runAuditGates(input);
    const gate = gates[2];
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("totales_economicos_ausentes");
  });

  it("bloquea si el subtotal de una partida no coincide con cantidad × precio unitario", () => {
    const input = cleanInput();
    input.economicLineItems = [{ concept: "instalacion", quantity: 2, unitPriceCents: 10_000n, subtotalCents: 25_000n }];
    const gates = runAuditGates(input);
    const gate = gates[2];
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("subtotal_de_partida_inconsistente");
  });

  it("bloquea si la suma de partidas no coincide con el subtotal declarado", () => {
    const input = cleanInput();
    input.economicTotals = { ...input.economicTotals!, subtotalCents: 999_999n };
    const gates = runAuditGates(input);
    const gate = gates[2];
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("subtotal_total_inconsistente");
  });

  it("bloquea si el IVA declarado no coincide con el recalculado half-up", () => {
    const input = cleanInput();
    input.economicTotals = { ...input.economicTotals!, ivaCents: 1n };
    const gates = runAuditGates(input);
    const gate = gates[2];
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("iva_inconsistente");
  });

  it("bloquea si total !== subtotal + iva", () => {
    const input = cleanInput();
    input.economicTotals = { ...input.economicTotals!, totalCents: 1n };
    const gates = runAuditGates(input);
    const gate = gates[2];
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("total_inconsistente");
  });

  it("bloquea cantidades no enteras/negativas en vez de calcular sobre ellas", () => {
    const input = cleanInput();
    input.economicLineItems = [{ concept: "instalacion", quantity: 1.5, unitPriceCents: 10_000n, subtotalCents: 15_000n }];
    const gates = runAuditGates(input);
    const gate = gates[2];
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("cantidad_no_entera");
  });
});

describe("gate: formato", () => {
  it("bloquea cada sección obligatoria faltante", () => {
    const input = cleanInput();
    input.presentSections = ["tecnica"];
    const gates = runAuditGates(input);
    const gate = gates[3];
    expect(gate.passed).toBe(false);
    expect(gate.findings).toHaveLength(2); // economica y legal faltan
  });
});

describe("gate: coherencia_tecnica_economica", () => {
  it("bloquea un compromiso técnico sin partida económica que lo respalde", () => {
    const input = cleanInput();
    input.technicalCommitmentConcepts = ["instalacion", "mantenimiento", "capacitacion"];
    const gates = runAuditGates(input);
    const gate = gates[4];
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("compromiso_tecnico_sin_precio");
  });

  it("bloquea una partida económica sin respaldo técnico (posible partida fabricada)", () => {
    const input = cleanInput();
    input.economicLineItems = [
      ...input.economicLineItems,
      { concept: "consultoria_no_prometida", quantity: 1, unitPriceCents: 1_000n, subtotalCents: 1_000n },
    ];
    // El subtotal total ya no cuadra con este cambio; para aislar el gate 5, ajustamos totales también.
    input.economicTotals = {
      subtotalCents: 81_000n,
      ivaRate: 0.16,
      ivaCents: 12_960n,
      totalCents: 93_960n,
    };
    const gates = runAuditGates(input);
    const gate = gates[4];
    expect(gate.passed).toBe(false);
    expect(gate.findings.map((f) => f.code)).toContain("partida_economica_sin_respaldo_tecnico");
  });
});
