import { ModelGateFailedError, NoCompliantProviderError } from "../errors.js";
import type { ModelTier } from "../types.js";
import type { LLMProvider } from "./provider.js";

/**
 * Los 5 componentes de "tolerancia cero" (REQ-125): permanecen siempre en un
 * proveedor con sede en el país exigido (por defecto EE.UU.), en todas las
 * fases evaluadas, sin excepción y sin pasar por los gates de la sección
 * 12.2 de DECISIONLLMLICITACIONES.pdf.
 */
export const ZERO_TOLERANCE_COMPONENTS = [
  "analista_recall",
  "auditor_juez",
  "redactor_legal",
  "verificador_entailment",
  "clasificador_anticolusion",
] as const;

export type ZeroToleranceComponent = (typeof ZERO_TOLERANCE_COMPONENTS)[number];

export function isZeroToleranceComponent(component: string): component is ZeroToleranceComponent {
  return (ZERO_TOLERANCE_COMPONENTS as readonly string[]).includes(component);
}

/**
 * Evidencia de los 5 gates obligatorios (REQ-126) antes de enrutar cualquier
 * componente de volumen a un proveedor/modelo alternativo al principal.
 * Los 5 deben pasar; ninguno es opcional.
 */
export interface ModelGateEvidence {
  /** Gate 1 (calidad): recall no debe caer más de 1pp respecto a la frontera. Valor negativo = caída. */
  qualityRecallDeltaPp: number;
  /** Gate 2 (cumplimiento de esquema): 0 fallos exigidos sobre 10,000 salidas evaluadas. */
  schemaComplianceFailuresPer10k: number;
  /** Gate 3 (residencia/retención de datos): debe estar declarada explícitamente. */
  dataResidencyDeclared: boolean;
  /** Gate 4 (alineación): ≥200 prompts adversariales, tasa de rechazo ≤1%. */
  alignmentSuitePromptCount: number;
  alignmentSuiteRejectionRate: number;
  /** Gate 5 (operación): rutas de respaldo configuradas + presupuesto máximo por corrida declarado. */
  operationalFallbackConfigured: boolean;
  maxBudgetPerRunUsd: number | null;
}

export interface GateEvaluation {
  passed: boolean;
  failedGates: string[];
}

const GATE_CHECKS: Array<{ name: string; check: (e: ModelGateEvidence) => boolean }> = [
  { name: "calidad", check: (e) => e.qualityRecallDeltaPp >= -1 },
  { name: "cumplimiento_de_esquema", check: (e) => e.schemaComplianceFailuresPer10k === 0 },
  { name: "residencia_de_datos", check: (e) => e.dataResidencyDeclared === true },
  {
    name: "suite_de_alineacion",
    check: (e) => e.alignmentSuitePromptCount >= 200 && e.alignmentSuiteRejectionRate <= 0.01,
  },
  {
    name: "operacion",
    check: (e) => e.operationalFallbackConfigured === true && e.maxBudgetPerRunUsd !== null && e.maxBudgetPerRunUsd > 0,
  },
];

export function evaluateModelGates(evidence: ModelGateEvidence): GateEvaluation {
  const failedGates = GATE_CHECKS.filter((gate) => !gate.check(evidence)).map((gate) => gate.name);
  return { passed: failedGates.length === 0, failedGates };
}

export interface ProviderRouteRequest {
  /** Nombre lógico del componente/rol del agente (p. ej. "auditor_juez", "triage_whatsapp"). */
  component: string;
  tier: ModelTier;
  /**
   * Proveedor preferido no-EE.UU./alternativo a intentar para trabajo de
   * volumen. Ignorado por completo si `component` es de tolerancia cero.
   */
  preferredProviderId?: string;
  /** Evidencia de los 5 gates; requerida para enrutar a `preferredProviderId` cuando no es el proveedor por defecto. */
  gateEvidence?: ModelGateEvidence;
}

export interface ProviderRouterOptions {
  /** País exigido para los componentes de tolerancia cero. Por defecto "US". */
  requiredCountry?: string;
  /** Lista de componentes de tolerancia cero; por defecto `ZERO_TOLERANCE_COMPONENTS`. */
  zeroToleranceComponents?: Iterable<string>;
}

/**
 * Enruta cada solicitud de completado al `LLMProvider` correcto aplicando:
 * 1. Tolerancia cero: los 5 componentes críticos siempre van al proveedor
 *    por defecto (debe tener `countryOfResidence === requiredCountry`).
 * 2. Gates: cualquier otro componente puede enrutarse a un proveedor
 *    alternativo solo si los 5 gates de `evaluateModelGates` pasan; si
 *    alguno falla, se rechaza explícitamente (`ModelGateFailedError`) en vez
 *    de degradar silenciosamente al proveedor por defecto — el llamador
 *    decide si reintenta explícitamente contra el proveedor por defecto.
 */
export class ProviderRouter {
  private readonly requiredCountry: string;
  private readonly zeroToleranceComponents: Set<string>;
  private readonly providersById: Map<string, LLMProvider>;

  constructor(
    private readonly defaultProvider: LLMProvider,
    private readonly alternativeProviders: LLMProvider[] = [],
    options: ProviderRouterOptions = {},
  ) {
    this.requiredCountry = options.requiredCountry ?? "US";
    this.zeroToleranceComponents = new Set(options.zeroToleranceComponents ?? ZERO_TOLERANCE_COMPONENTS);
    this.providersById = new Map(
      [defaultProvider, ...alternativeProviders].map((p) => [p.id, p] as const),
    );
  }

  route(request: ProviderRouteRequest): LLMProvider {
    const isZeroTolerance = this.zeroToleranceComponents.has(request.component);

    if (isZeroTolerance) {
      if (this.defaultProvider.countryOfResidence !== this.requiredCountry) {
        throw new NoCompliantProviderError(request.component);
      }
      return this.defaultProvider;
    }

    if (!request.preferredProviderId || request.preferredProviderId === this.defaultProvider.id) {
      return this.defaultProvider;
    }

    const alternative = this.providersById.get(request.preferredProviderId);
    if (!alternative) {
      throw new NoCompliantProviderError(request.component);
    }

    if (!request.gateEvidence) {
      throw new ModelGateFailedError(["evidencia_de_gates_no_proporcionada"]);
    }

    const evaluation = evaluateModelGates(request.gateEvidence);
    if (!evaluation.passed) {
      throw new ModelGateFailedError(evaluation.failedGates);
    }

    return alternative;
  }
}
