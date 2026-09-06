import { describe, expect, it } from "vitest";
import {
  ProviderRouter,
  evaluateModelGates,
  isZeroToleranceComponent,
  ZERO_TOLERANCE_COMPONENTS,
  type ModelGateEvidence,
} from "../../src/llm/router.js";
import { FakeProvider } from "../../src/llm/fake-provider.js";
import { ModelGateFailedError, NoCompliantProviderError } from "../../src/errors.js";
import type { LLMCompletionRequest, LLMCompletionResult, LLMProvider } from "../../src/llm/provider.js";

const passingGateEvidence: ModelGateEvidence = {
  qualityRecallDeltaPp: 0,
  schemaComplianceFailuresPer10k: 0,
  dataResidencyDeclared: true,
  alignmentSuitePromptCount: 250,
  alignmentSuiteRejectionRate: 0.005,
  operationalFallbackConfigured: true,
  maxBudgetPerRunUsd: 5,
};

function makeNonUsProvider(id: string): LLMProvider {
  return {
    id,
    countryOfResidence: "EU",
    supportsToolCalls: true,
    async complete(_req: LLMCompletionRequest): Promise<LLMCompletionResult> {
      return { content: `desde-${id}`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *stream() {
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

describe("evaluateModelGates", () => {
  it("pasa cuando los 5 gates cumplen", () => {
    expect(evaluateModelGates(passingGateEvidence)).toEqual({ passed: true, failedGates: [] });
  });

  it("falla el gate de calidad si el recall cae más de 1pp", () => {
    const evaluation = evaluateModelGates({ ...passingGateEvidence, qualityRecallDeltaPp: -1.5 });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failedGates).toContain("calidad");
  });

  it("falla el gate de esquema si hay algún fallo en 10k salidas", () => {
    const evaluation = evaluateModelGates({ ...passingGateEvidence, schemaComplianceFailuresPer10k: 1 });
    expect(evaluation.failedGates).toContain("cumplimiento_de_esquema");
  });

  it("falla el gate de residencia si no está declarada", () => {
    const evaluation = evaluateModelGates({ ...passingGateEvidence, dataResidencyDeclared: false });
    expect(evaluation.failedGates).toContain("residencia_de_datos");
  });

  it("falla el gate de alineación si hay menos de 200 prompts o rechazo >1%", () => {
    expect(evaluateModelGates({ ...passingGateEvidence, alignmentSuitePromptCount: 150 }).failedGates).toContain(
      "suite_de_alineacion",
    );
    expect(evaluateModelGates({ ...passingGateEvidence, alignmentSuiteRejectionRate: 0.02 }).failedGates).toContain(
      "suite_de_alineacion",
    );
  });

  it("falla el gate de operación si falta ruta de respaldo o presupuesto máximo", () => {
    expect(evaluateModelGates({ ...passingGateEvidence, operationalFallbackConfigured: false }).failedGates).toContain(
      "operacion",
    );
    expect(evaluateModelGates({ ...passingGateEvidence, maxBudgetPerRunUsd: null }).failedGates).toContain("operacion");
  });

  it("reporta todos los gates fallidos a la vez, no solo el primero", () => {
    const evaluation = evaluateModelGates({
      qualityRecallDeltaPp: -5,
      schemaComplianceFailuresPer10k: 3,
      dataResidencyDeclared: false,
      alignmentSuitePromptCount: 10,
      alignmentSuiteRejectionRate: 0.5,
      operationalFallbackConfigured: false,
      maxBudgetPerRunUsd: null,
    });
    expect(evaluation.failedGates).toHaveLength(5);
  });
});

describe("isZeroToleranceComponent", () => {
  it("identifica los 5 componentes de tolerancia cero de REQ-125", () => {
    expect(ZERO_TOLERANCE_COMPONENTS).toEqual([
      "analista_recall",
      "auditor_juez",
      "redactor_legal",
      "verificador_entailment",
      "clasificador_anticolusion",
    ]);
    for (const component of ZERO_TOLERANCE_COMPONENTS) {
      expect(isZeroToleranceComponent(component)).toBe(true);
    }
    expect(isZeroToleranceComponent("triage_whatsapp")).toBe(false);
  });
});

describe("ProviderRouter", () => {
  it("enruta un componente de tolerancia cero siempre al proveedor por defecto (US)", () => {
    const usProvider = new FakeProvider();
    const euProvider = makeNonUsProvider("eu-provider");
    const router = new ProviderRouter(usProvider, [euProvider]);

    const routed = router.route({ component: "auditor_juez", tier: "premium", preferredProviderId: "eu-provider" });
    expect(routed.id).toBe(usProvider.id); // ignora preferredProviderId por completo
  });

  it("lanza NoCompliantProviderError si el proveedor por defecto no cumple el país exigido para tolerancia cero", () => {
    const nonUsDefault = makeNonUsProvider("default-eu");
    const router = new ProviderRouter(nonUsDefault, [], { requiredCountry: "US" });
    expect(() => router.route({ component: "auditor_juez", tier: "premium" })).toThrow(NoCompliantProviderError);
  });

  it("un componente que no es de volumen ni pide alternativa usa el proveedor por defecto", () => {
    const usProvider = new FakeProvider();
    const router = new ProviderRouter(usProvider, []);
    const routed = router.route({ component: "triage_whatsapp", tier: "economico" });
    expect(routed.id).toBe(usProvider.id);
  });

  it("enruta un componente de volumen a un proveedor alternativo solo si los 5 gates pasan", () => {
    const usProvider = new FakeProvider();
    const altProvider = makeNonUsProvider("openrouter-barato");
    const router = new ProviderRouter(usProvider, [altProvider]);

    const routed = router.route({
      component: "triage_whatsapp",
      tier: "economico",
      preferredProviderId: "openrouter-barato",
      gateEvidence: passingGateEvidence,
    });
    expect(routed.id).toBe("openrouter-barato");
  });

  it("rechaza el enrutamiento alternativo si falta la evidencia de gates", () => {
    const usProvider = new FakeProvider();
    const altProvider = makeNonUsProvider("openrouter-barato");
    const router = new ProviderRouter(usProvider, [altProvider]);

    expect(() =>
      router.route({ component: "triage_whatsapp", tier: "economico", preferredProviderId: "openrouter-barato" }),
    ).toThrow(ModelGateFailedError);
  });

  it("rechaza el enrutamiento alternativo si algún gate falla, sin degradar silenciosamente", () => {
    const usProvider = new FakeProvider();
    const altProvider = makeNonUsProvider("openrouter-barato");
    const router = new ProviderRouter(usProvider, [altProvider]);

    expect(() =>
      router.route({
        component: "triage_whatsapp",
        tier: "economico",
        preferredProviderId: "openrouter-barato",
        gateEvidence: { ...passingGateEvidence, schemaComplianceFailuresPer10k: 2 },
      }),
    ).toThrow(ModelGateFailedError);
  });

  it("lanza NoCompliantProviderError si preferredProviderId no está registrado", () => {
    const usProvider = new FakeProvider();
    const router = new ProviderRouter(usProvider, []);
    expect(() =>
      router.route({ component: "triage_whatsapp", tier: "economico", preferredProviderId: "no-existe" }),
    ).toThrow(NoCompliantProviderError);
  });

  it("permite personalizar la lista de componentes de tolerancia cero", () => {
    const usProvider = new FakeProvider();
    const altProvider = makeNonUsProvider("alt");
    const router = new ProviderRouter(usProvider, [altProvider], { zeroToleranceComponents: ["mi_componente_critico"] });

    // Ya no es de tolerancia cero "auditor_juez" con esta config personalizada: puede enrutarse con gates.
    const routed = router.route({
      component: "auditor_juez",
      tier: "premium",
      preferredProviderId: "alt",
      gateEvidence: passingGateEvidence,
    });
    expect(routed.id).toBe("alt");
  });
});
