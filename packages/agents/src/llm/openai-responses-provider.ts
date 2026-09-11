import { MissingCredentialsError, NonRetryableProviderError, RetryableProviderError } from "../errors.js";
import type { ModelTier } from "../types.js";
import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMProvider,
  LLMStreamEvent,
  LLMToolCallRequest,
} from "./provider.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Modelos por defecto por nivel (REQ-124: barato=triage/mensajería,
 * medio=extracción/auditoría, caro=redacción técnica/detección de bases
 * dirigidas). Configurables vía `OpenAIResponsesProviderOptions.modelByTier`
 * porque los IDs de modelo cambian más rápido que este código.
 */
export const DEFAULT_MODEL_BY_TIER: Record<ModelTier, string> = {
  economico: "gpt-4o-mini",
  estandar: "gpt-4.1",
  premium: "gpt-4.1",
};

export interface OpenAIResponsesProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  modelByTier?: Partial<Record<ModelTier, string>>;
}

/**
 * Proveedor real contra la OpenAI Responses API (REQ-124: runtime de
 * agentes = OpenAI Agents SDK + Responses API). Lee `OPENAI_API_KEY` de
 * variables de entorno por defecto (nunca hardcodeada). No hace ninguna
 * llamada de red en tiempo de import; `fetchImpl` es inyectable para que las
 * pruebas nunca toquen la red real.
 *
 * PENDIENTE: no se ha ejercitado contra la API real (requiere credenciales
 * de producción, ver README.md). Que las pruebas pasen contra un `fetch`
 * simulado no certifica la integración real.
 */
export class OpenAIResponsesProvider implements LLMProvider {
  readonly id = "openai";
  readonly countryOfResidence = "US";
  readonly supportsToolCalls = true;

  private readonly baseUrl: string;
  private readonly modelByTier: Record<ModelTier, string>;

  constructor(private readonly options: OpenAIResponsesProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.openai.com/v1";
    this.modelByTier = { ...DEFAULT_MODEL_BY_TIER, ...options.modelByTier };
  }

  private getApiKey(): string {
    const key = this.options.apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) {
      throw new MissingCredentialsError(
        "OPENAI_API_KEY no está configurada. La integración real con OpenAI Responses API está pendiente de credenciales (ver README.md).",
      );
    }
    return key;
  }

  private resolveModel(request: LLMCompletionRequest): string {
    return request.model || this.modelByTier[request.tier];
  }

  private buildRequestBody(request: LLMCompletionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.resolveModel(request),
      input: request.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
    }
    if (request.maxOutputTokens !== undefined) {
      body.max_output_tokens = request.maxOutputTokens;
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature;
    }
    return body;
  }

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    const apiKey = this.getApiKey();
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new MissingCredentialsError("No hay implementación de fetch disponible en este entorno");
    }

    const response = await fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(this.buildRequestBody(request)),
      signal: request.signal,
    });

    if (!response.ok) {
      await this.throwForStatus(response);
    }

    const json = (await response.json()) as OpenAIResponsesApiPayload;
    return mapResponsesApiPayload(json);
  }

  private async throwForStatus(response: Response): Promise<never> {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      // El cuerpo puede no estar disponible; no bloquea la clasificación del error.
    }
    const message = `OpenAI Responses API respondió ${response.status}: ${bodyText || response.statusText}`;
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableProviderError(message, response.status);
    }
    throw new NonRetryableProviderError(message, response.status);
  }

  stream(_request: LLMCompletionRequest): AsyncIterable<LLMStreamEvent> {
    throw new MissingCredentialsError(
      "El streaming de OpenAIResponsesProvider está pendiente de credenciales/validación real (ver README.md)",
    );
  }
}

interface OpenAIResponsesApiPayload {
  output?: Array<
    | { type: "message"; content?: Array<{ type: string; text?: string }> }
    | { type: "function_call"; call_id?: string; id?: string; name: string; arguments: string }
  >;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function mapResponsesApiPayload(payload: OpenAIResponsesApiPayload): LLMCompletionResult {
  let content = "";
  const toolCalls: LLMToolCallRequest[] = [];

  for (const item of payload.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (typeof part.text === "string") content += part.text;
      }
    } else if (item.type === "function_call") {
      let parsedArgs: unknown = item.arguments;
      try {
        parsedArgs = JSON.parse(item.arguments);
      } catch {
        // Si el proveedor no manda JSON válido se conserva el string crudo.
      }
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call-${toolCalls.length}`,
        name: item.name,
        arguments: parsedArgs,
      });
    }
  }

  return {
    content,
    toolCalls,
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
    },
    raw: payload,
  };
}
