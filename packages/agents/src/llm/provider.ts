import type { ModelTier } from "../types.js";

export type LLMRole = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  role: LLMRole;
  content: string;
}

export interface LLMToolSpec {
  name: string;
  description: string;
  /** JSON Schema de los parámetros (compatible con Responses API `tools[].parameters`). */
  parameters: Record<string, unknown>;
}

export interface LLMToolCallRequest {
  id: string;
  name: string;
  arguments: unknown;
}

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMCompletionRequest {
  /** Modelo concreto del proveedor (p. ej. "gpt-5-mini"); lo resuelve el `ProviderRouter`/tier mapping. */
  model: string;
  tier: ModelTier;
  messages: LLMMessage[];
  tools?: LLMToolSpec[];
  maxOutputTokens?: number;
  /**
   * Temperatura de muestreo. Opcional: la mayoría de las herramientas de
   * negocio no la necesitan y la omiten (queda a la temperatura por
   * defecto del proveedor). Componentes que requieren salida determinista
   * (p. ej. `auditor_juez`, REQ-037/REQ-039/REQ-127: "juez LLM
   * determinista") deben fijarla explícitamente en `0` — ver
   * `packages/agents/src/audit/judge.ts`. No es una garantía criptográfica
   * de determinismo (ningún proveedor la ofrece hoy), pero es el mecanismo
   * estándar de la industria ("temperatura 0 o equivalente") para maximizar
   * la reproducibilidad de la salida.
   */
  temperature?: number;
  signal?: AbortSignal;
}

export interface LLMCompletionResult {
  content: string;
  toolCalls: LLMToolCallRequest[];
  usage: LLMUsage;
  raw?: unknown;
}

export type LLMStreamEvent =
  | { type: "content_delta"; delta: string }
  | { type: "tool_call"; toolCall: LLMToolCallRequest }
  | { type: "done"; usage: LLMUsage };

/**
 * Abstracción de proveedor de LLM (REQ-124/REQ-126). Cada proveedor declara
 * su país de residencia legal (`countryOfResidence`) para que
 * `ProviderRouter` pueda aplicar la regla de tolerancia cero (REQ-125): los
 * 5 componentes críticos jamás enrutan fuera de un proveedor con sede en
 * EE.UU.
 */
export interface LLMProvider {
  readonly id: string;
  readonly countryOfResidence: string;
  readonly supportsToolCalls: boolean;
  complete(request: LLMCompletionRequest): Promise<LLMCompletionResult>;
  stream(request: LLMCompletionRequest): AsyncIterable<LLMStreamEvent>;
}
