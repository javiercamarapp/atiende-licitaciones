/**
 * Juez LLM determinista del auditor (REQ-037/REQ-039/REQ-125/REQ-127):
 * "misma entrada -> mismo veredicto" hasta donde el proveedor lo permite
 * (temperatura 0), esquema estructurado validado con zod, y SOLO se invoca
 * después de que los 5 gates deterministas de `gates.ts` ya pasaron
 * (`AuditReport.blocking = []`) — nunca decide elegibilidad ni puede crear
 * un `blocking`, solo aporta `warnings` (REQ-009: "LLM solo para
 * explicar").
 *
 * Adaptador real: cualquier `LLMProvider` inyectado vía `ProviderRouter`
 * (hoy, `OpenAIResponsesProvider` — REQ-124/REQ-125: `auditor_juez` es un
 * componente de "tolerancia cero", el router lo fuerza siempre al
 * proveedor con sede en EE.UU., sin excepción de configuración). Adaptador
 * fake explícito para pruebas: `FakeProvider` con un script determinista
 * (nunca se mockea la lógica de negocio de este archivo, solo el borde
 * externo — parseo/validación de esquema y decisión de warnings corren con
 * código real).
 *
 * PENDIENTE HONESTO (REQ-038/REQ-127): `AUDIT_JUDGE_CALIBRATED_AGAINST_REAL_ANNOTATORS`
 * es `false` y así debe permanecer hasta que exista (a) credenciales reales
 * de un proveedor LLM en producción y (b) un gold-set anotado por humanos
 * contra el cual medir la tasa de acuerdo del juez (REQ-127: "calibrado
 * contra anotadores humanos"). Ninguno existe hoy en este repo — no se
 * fabrica esa calibración. Ver docs/ACEPTACION.md REQ-037/REQ-038/REQ-127.
 */

import { z } from "zod";
import type { ModelTier } from "../types.js";
import { stableStringify } from "../tracing.js";
import type { LLMMessage } from "../llm/provider.js";
import type { ProviderRouter } from "../llm/router.js";
import type { AuditInput } from "./gates.js";

/** REQ-125: uno de los 5 componentes de tolerancia cero de `ProviderRouter` — nunca enruta fuera del proveedor con sede en EE.UU., sin importar configuración de tenant. */
export const AUDIT_JUDGE_COMPONENT = "auditor_juez" as const;

/** REQ-037/REQ-039/REQ-127: temperatura fija en 0 para maximizar reproducibilidad ("misma entrada -> mismo veredicto"). Nunca configurable desde fuera de este módulo. */
export const AUDIT_JUDGE_TEMPERATURE = 0;

/**
 * REQ-038/REQ-127 (regla de oro "nunca fabricar cumplimiento/calibración"):
 * hasta que exista un gold-set anotado por humanos Y se ejecute contra el
 * proveedor real, esta constante permanece `false`. Ningún test ni código
 * de este paquete puede "demostrar" calibración marcando esto en `true` sin
 * ese trabajo real — se deja como constante exportada, visible, en vez de
 * un comentario que alguien pueda pasar por alto.
 */
export const AUDIT_JUDGE_CALIBRATED_AGAINST_REAL_ANNOTATORS = false as const;

const auditJudgeVerdictSchema = z.object({
  resumenEjecutivo: z.string().min(1),
  advertenciasAdicionales: z.array(z.string()),
});

export type AuditJudgeVerdict = z.infer<typeof auditJudgeVerdictSchema>;

/**
 * Resultado de una corrida del juez. `salida_invalida` cubre tanto un JSON
 * malformado como un JSON que no cumple el esquema — en ambos casos el
 * comentario del juez se descarta (nunca se "adivina" un veredicto parcial
 * a partir de una salida que no cumplió el contrato).
 */
export type AuditJudgeOutcome =
  | { status: "ok"; verdict: AuditJudgeVerdict }
  | { status: "salida_invalida"; rawContent: string };

const SYSTEM_PROMPT = [
  "Eres el juez de auditoría (auditor_juez) de un sistema de licitaciones gubernamentales en México.",
  "El paquete que revisas YA PASÓ los 5 gates deterministas obligatorios",
  "(matriz completa, citas a evidencia real, consistencia numérica, formato,",
  "coherencia técnica-económica). Tu única función es EXPLICAR y advertir,",
  "nunca decidir elegibilidad, precio, ni bloquear nada: eso ya lo decidió",
  "código determinista antes de que te llamen.",
  "Responde EXCLUSIVAMENTE con un objeto JSON válido, sin texto antes ni",
  "después, exactamente con esta forma:",
  '{"resumenEjecutivo": "string", "advertenciasAdicionales": ["string", ...]}',
  "\"advertenciasAdicionales\" son observaciones NO bloqueantes para revisión",
  "humana (p. ej. redacción ambigua, riesgo residual). Nunca inventes datos",
  "que no estén en el resumen entregado.",
].join(" ");

/**
 * Resumen COMPACTO y determinista del `AuditInput` para el prompt del
 * juez: nunca se le manda al LLM el paquete completo (menor superficie de
 * exposición de datos sensibles), y todos los campos son serializables por
 * JSON.stringify (los montos en centavos, `bigint`, se convierten a string
 * explícitamente — `JSON.stringify` no soporta `bigint` de forma nativa).
 */
export interface AuditJudgeSummary {
  packageId: string;
  organizationId: string | null;
  requirementCount: number;
  claimCount: number;
  economicTotals: { subtotalCents: string; ivaCents: string; totalCents: string } | null;
  presentSections: string[];
}

export function buildAuditJudgeSummary(input: AuditInput): AuditJudgeSummary {
  return {
    packageId: input.packageId,
    organizationId: input.organizationId,
    requirementCount: input.complianceMatrix.length,
    claimCount: input.claims.length,
    economicTotals: input.economicTotals
      ? {
          subtotalCents: input.economicTotals.subtotalCents.toString(),
          ivaCents: input.economicTotals.ivaCents.toString(),
          totalCents: input.economicTotals.totalCents.toString(),
        }
      : null,
    // Orden explícito (no depende de cómo el llamador armó el arreglo): el
    // prompt debe ser idéntico para el mismo conjunto de secciones sin
    // importar el orden de inserción.
    presentSections: [...input.presentSections].sort(),
  };
}

/**
 * Prompt canónico: `stableStringify` (mismo helper que `tracing.ts` usa
 * para `hashValue`) ordena las claves recursivamente, así que la MISMA
 * entrada produce SIEMPRE el mismo texto de prompt sin importar el orden
 * en que el llamador construyó los objetos — condición necesaria (junto
 * con temperatura 0) para "misma entrada -> mismo veredicto".
 */
export function buildDeterministicJudgePrompt(input: AuditInput): string {
  return stableStringify(buildAuditJudgeSummary(input));
}

function parseJudgeOutput(content: string): AuditJudgeOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { status: "salida_invalida", rawContent: content };
  }
  const result = auditJudgeVerdictSchema.safeParse(parsed);
  if (!result.success) {
    return { status: "salida_invalida", rawContent: content };
  }
  return { status: "ok", verdict: result.data };
}

export interface AuditJudgeOptions {
  router: ProviderRouter;
  /** Modelo concreto a solicitar (p. ej. "gpt-4.1"). Debe ser distinto del modelo del redactor (REQ-039) — la invariante de PROVEEDOR ya la fuerza `ProviderRouter` (REQ-125); esto es la invariante de MODELO dentro de ese mismo proveedor. */
  model: string;
  tier?: ModelTier;
}

export class AuditJudge {
  private readonly tier: ModelTier;

  constructor(private readonly options: AuditJudgeOptions) {
    this.tier = options.tier ?? "premium";
  }

  /**
   * Invoca al proveedor enrutado para `auditor_juez` (REQ-125: siempre el
   * proveedor de tolerancia cero, sin excepción) con temperatura 0 y un
   * prompt canónico. Nunca debe llamarse si algún gate determinista
   * bloqueó — ver `buildAuditReport` en `audit-report.ts`, que es el único
   * llamador previsto en este paquete.
   */
  async evaluate(input: AuditInput): Promise<AuditJudgeOutcome> {
    const provider = this.options.router.route({ component: AUDIT_JUDGE_COMPONENT, tier: this.tier });
    const messages: LLMMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildDeterministicJudgePrompt(input) },
    ];
    const result = await provider.complete({
      model: this.options.model,
      tier: this.tier,
      temperature: AUDIT_JUDGE_TEMPERATURE,
      messages,
    });
    return parseJudgeOutput(result.content);
  }
}
