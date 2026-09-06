import { createHash } from "node:crypto";
import type {
  LLMCompletionRequest,
  LLMCompletionResult,
  LLMProvider,
  LLMStreamEvent,
} from "./provider.js";

export type FakeProviderScript = (request: LLMCompletionRequest) => LLMCompletionResult;

/**
 * Proveedor determinista para pruebas y desarrollo sin credenciales. Nunca
 * llama a la red. Por defecto responde con un contenido derivado
 * determinísticamente (hash) de los mensajes de entrada, para que las
 * pruebas puedan afirmar igualdad byte a byte entre corridas repetidas con
 * el mismo input.
 *
 * IMPORTANTE: pasar la suite con `FakeProvider` NO certifica la integración
 * real con ningún proveedor. Ver README.md, sección "Pendientes".
 */
export class FakeProvider implements LLMProvider {
  readonly id = "fake";
  readonly countryOfResidence = "US";
  readonly supportsToolCalls = true;

  constructor(private readonly script?: FakeProviderScript) {}

  async complete(request: LLMCompletionRequest): Promise<LLMCompletionResult> {
    if (this.script) return this.script(request);
    const digest = createHash("sha256")
      .update(request.messages.map((m) => `${m.role}:${m.content}`).join("\n"))
      .digest("hex")
      .slice(0, 16);
    const inputTokens = request.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    return {
      content: `[fake:${request.tier}:${digest}]`,
      toolCalls: [],
      usage: { inputTokens, outputTokens: 8 },
      raw: { fake: true },
    };
  }

  async *stream(request: LLMCompletionRequest): AsyncIterable<LLMStreamEvent> {
    const result = await this.complete(request);
    yield { type: "content_delta", delta: result.content };
    yield { type: "done", usage: result.usage };
  }
}
