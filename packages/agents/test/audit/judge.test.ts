import { describe, expect, it } from "vitest";
import {
  AUDIT_JUDGE_CALIBRATED_AGAINST_REAL_ANNOTATORS,
  AUDIT_JUDGE_COMPONENT,
  AUDIT_JUDGE_TEMPERATURE,
  AuditJudge,
  buildDeterministicJudgePrompt,
} from "../../src/audit/judge.js";
import type { AuditInput } from "../../src/audit/gates.js";
import { ProviderRouter } from "../../src/llm/router.js";
import { FakeProvider } from "../../src/llm/fake-provider.js";
import type { LLMCompletionRequest, LLMCompletionResult } from "../../src/llm/provider.js";

function sampleInput(overrides: Partial<AuditInput> = {}): AuditInput {
  return {
    packageId: "pkg-1",
    organizationId: "org-1",
    complianceMatrix: [{ id: "req-1", obligatoriedad: "obligatorio", status: "cumplido" }],
    hasUnresolvedConflicts: false,
    claims: [{ id: "claim-1", text: "texto", sourceDocIds: ["doc-1"] }],
    knownEvidenceDocIds: ["doc-1"],
    economicLineItems: [{ concept: "instalacion", quantity: 1, unitPriceCents: 10_000n, subtotalCents: 10_000n }],
    economicTotals: { subtotalCents: 10_000n, ivaRate: 0.16, ivaCents: 1_600n, totalCents: 11_600n },
    requiredSections: ["tecnica"],
    presentSections: ["tecnica"],
    technicalCommitmentConcepts: ["instalacion"],
    ...overrides,
  };
}

describe("buildDeterministicJudgePrompt", () => {
  it("produce el mismo texto para el mismo AuditInput sin importar el orden de construcción del objeto", () => {
    const a = sampleInput();
    // Mismo contenido, construido con las claves en otro orden y arreglos re-materializados.
    const b: AuditInput = {
      technicalCommitmentConcepts: ["instalacion"],
      presentSections: ["tecnica"],
      requiredSections: ["tecnica"],
      economicTotals: { totalCents: 11_600n, ivaCents: 1_600n, ivaRate: 0.16, subtotalCents: 10_000n },
      economicLineItems: [{ subtotalCents: 10_000n, unitPriceCents: 10_000n, quantity: 1, concept: "instalacion" }],
      knownEvidenceDocIds: ["doc-1"],
      claims: [{ sourceDocIds: ["doc-1"], text: "texto", id: "claim-1" }],
      hasUnresolvedConflicts: false,
      complianceMatrix: [{ status: "cumplido", obligatoriedad: "obligatorio", id: "req-1" }],
      organizationId: "org-1",
      packageId: "pkg-1",
    };
    expect(buildDeterministicJudgePrompt(a)).toBe(buildDeterministicJudgePrompt(b));
  });

  it("cambia si cambia un dato relevante del insumo", () => {
    const a = sampleInput();
    const b = sampleInput({ packageId: "pkg-2" });
    expect(buildDeterministicJudgePrompt(a)).not.toBe(buildDeterministicJudgePrompt(b));
  });

  it("nunca lanza al serializar montos bigint (JSON.stringify no soporta bigint de forma nativa)", () => {
    expect(() => buildDeterministicJudgePrompt(sampleInput())).not.toThrow();
  });
});

function routerWithScript(
  script: (request: LLMCompletionRequest) => LLMCompletionResult,
): ProviderRouter {
  return new ProviderRouter(new FakeProvider(script));
}

describe("AuditJudge — determinismo (misma entrada -> mismo veredicto)", () => {
  it("dos evaluaciones del mismo insumo con el mismo adaptador producen el mismo veredicto", async () => {
    const router = routerWithScript((request) => ({
      content: JSON.stringify({
        resumenEjecutivo: `resumen para ${request.messages[1].content.length} caracteres`,
        advertenciasAdicionales: ["revisar redacción de la cláusula 4"],
      }),
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 10 },
    }));
    const judge = new AuditJudge({ router, model: "modelo-juez-test" });
    const input = sampleInput();

    const first = await judge.evaluate(input);
    const second = await judge.evaluate(input);

    expect(first).toEqual(second);
    expect(first.status).toBe("ok");
  });

  it("siempre pide temperatura 0 al proveedor, sin importar cómo se construya el AuditJudge", async () => {
    let capturedTemperature: number | undefined;
    const router = routerWithScript((request) => {
      capturedTemperature = request.temperature;
      return { content: JSON.stringify({ resumenEjecutivo: "ok", advertenciasAdicionales: [] }), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    });
    const judge = new AuditJudge({ router, model: "modelo-juez-test" });
    await judge.evaluate(sampleInput());
    expect(capturedTemperature).toBe(AUDIT_JUDGE_TEMPERATURE);
    expect(AUDIT_JUDGE_TEMPERATURE).toBe(0);
  });

  it("REQ-125: enruta por el componente de tolerancia cero auditor_juez — un proveedor sin sede en EE.UU. es rechazado", async () => {
    expect(AUDIT_JUDGE_COMPONENT).toBe("auditor_juez");
    const nonUsProvider: import("../../src/llm/provider.js").LLMProvider = {
      id: "eu-provider",
      countryOfResidence: "EU",
      supportsToolCalls: true,
      async complete() {
        return { content: JSON.stringify({ resumenEjecutivo: "no debería llegar aquí", advertenciasAdicionales: [] }), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
      async *stream() {
        yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    // auditor_juez es tolerancia cero (REQ-125): aunque sea el ÚNICO/proveedor
    // "por defecto" configurado, si no tiene sede en EE.UU. el router debe
    // rechazar antes de siquiera intentar llamarlo — nunca degradar en silencio.
    const router = new ProviderRouter(nonUsProvider);
    const judge = new AuditJudge({ router, model: "modelo-juez-test" });
    await expect(judge.evaluate(sampleInput())).rejects.toThrow(/Ningún proveedor cumple/);
  });
});

describe("AuditJudge — esquema estructurado (nunca fabrica un veredicto sobre salida inválida)", () => {
  it("marca salida_invalida si el proveedor no devuelve JSON", async () => {
    const router = routerWithScript(() => ({
      content: "esto no es JSON",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const judge = new AuditJudge({ router, model: "modelo-juez-test" });
    const outcome = await judge.evaluate(sampleInput());
    expect(outcome.status).toBe("salida_invalida");
    if (outcome.status === "salida_invalida") {
      expect(outcome.rawContent).toBe("esto no es JSON");
    }
  });

  it("marca salida_invalida si el JSON no cumple el esquema (p. ej. falta advertenciasAdicionales)", async () => {
    const router = routerWithScript(() => ({
      content: JSON.stringify({ resumenEjecutivo: "algo" }),
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const judge = new AuditJudge({ router, model: "modelo-juez-test" });
    const outcome = await judge.evaluate(sampleInput());
    expect(outcome.status).toBe("salida_invalida");
  });

  it("marca salida_invalida ante el adaptador fake por defecto (que no produce JSON)", async () => {
    const router = new ProviderRouter(new FakeProvider());
    const judge = new AuditJudge({ router, model: "modelo-juez-test" });
    const outcome = await judge.evaluate(sampleInput());
    expect(outcome.status).toBe("salida_invalida");
  });

  it("acepta un veredicto válido con advertencias vacías", async () => {
    const router = routerWithScript(() => ({
      content: JSON.stringify({ resumenEjecutivo: "todo en orden", advertenciasAdicionales: [] }),
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    const judge = new AuditJudge({ router, model: "modelo-juez-test" });
    const outcome = await judge.evaluate(sampleInput());
    expect(outcome).toEqual({ status: "ok", verdict: { resumenEjecutivo: "todo en orden", advertenciasAdicionales: [] } });
  });
});

describe("honestidad de calibración (REQ-038/REQ-127)", () => {
  it("declara explícitamente que el juez NO está calibrado contra anotadores humanos reales todavía", () => {
    expect(AUDIT_JUDGE_CALIBRATED_AGAINST_REAL_ANNOTATORS).toBe(false);
  });
});
