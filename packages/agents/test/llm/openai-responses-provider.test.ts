import { describe, expect, it, vi } from "vitest";
import { OpenAIResponsesProvider } from "../../src/llm/openai-responses-provider.js";
import { MissingCredentialsError, NonRetryableProviderError, RetryableProviderError } from "../../src/errors.js";
import type { LLMCompletionRequest } from "../../src/llm/provider.js";

function jsonResponse(status: number, body: unknown, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const baseRequest: LLMCompletionRequest = {
  model: "",
  tier: "estandar",
  messages: [
    { role: "system", content: "Eres el Auditor" },
    { role: "user", content: "Verifica la matriz de cumplimiento" },
  ],
  tools: [
    {
      name: "get_matrix",
      description: "obtiene la matriz de cumplimiento",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  ],
  maxOutputTokens: 500,
};

describe("OpenAIResponsesProvider", () => {
  it("lanza MissingCredentialsError si no hay OPENAI_API_KEY ni apiKey explícita, sin llegar a llamar fetch", async () => {
    const fetchImpl = vi.fn();
    const provider = new OpenAIResponsesProvider({ fetchImpl, apiKey: undefined });
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(provider.complete(baseRequest)).rejects.toThrow(MissingCredentialsError);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });

  it("construye la solicitud POST /responses con modelo por tier, headers, tools y max_output_tokens", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { output: [], usage: { input_tokens: 1, output_tokens: 1 } }),
    );
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-test-123", fetchImpl });

    await provider.complete(baseRequest);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test-123");
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-4.1"); // default para tier "estandar"
    expect(body.input).toEqual([
      { role: "system", content: "Eres el Auditor" },
      { role: "user", content: "Verifica la matriz de cumplimiento" },
    ]);
    expect(body.tools).toEqual([
      { type: "function", name: "get_matrix", description: "obtiene la matriz de cumplimiento", parameters: baseRequest.tools![0].parameters },
    ]);
    expect(body.max_output_tokens).toBe(500);
  });

  it("permite sobreescribir el mapeo de modelo por tier", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { output: [] }));
    const provider = new OpenAIResponsesProvider({
      apiKey: "sk-test",
      fetchImpl,
      modelByTier: { estandar: "gpt-custom-mid" },
    });
    await provider.complete(baseRequest);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.model).toBe("gpt-custom-mid");
  });

  it("mapea la respuesta: texto de mensaje + tool calls + usage", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        output: [
          { type: "message", content: [{ type: "output_text", text: "Todo en orden." }] },
          { type: "function_call", call_id: "call-1", name: "get_matrix", arguments: JSON.stringify({ id: "42" }) },
        ],
        usage: { input_tokens: 120, output_tokens: 30 },
      }),
    );
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-test", fetchImpl });

    const result = await provider.complete(baseRequest);

    expect(result.content).toBe("Todo en orden.");
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "get_matrix", arguments: { id: "42" } }]);
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it("lanza RetryableProviderError ante 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" }, "Too Many Requests"));
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-test", fetchImpl });
    await expect(provider.complete(baseRequest)).rejects.toThrow(RetryableProviderError);
  });

  it("lanza RetryableProviderError ante 500/503", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, { error: "unavailable" }));
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-test", fetchImpl });
    await expect(provider.complete(baseRequest)).rejects.toThrow(RetryableProviderError);
  });

  it("lanza NonRetryableProviderError ante 400/401/404", async () => {
    const fetchImpl400 = vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" }));
    const provider400 = new OpenAIResponsesProvider({ apiKey: "sk-test", fetchImpl: fetchImpl400 });
    await expect(provider400.complete(baseRequest)).rejects.toThrow(NonRetryableProviderError);

    const fetchImpl401 = vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    const provider401 = new OpenAIResponsesProvider({ apiKey: "sk-test", fetchImpl: fetchImpl401 });
    await expect(provider401.complete(baseRequest)).rejects.toThrow(NonRetryableProviderError);
  });

  it("declara countryOfResidence US (requisito para tolerancia cero)", () => {
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-test" });
    expect(provider.countryOfResidence).toBe("US");
    expect(provider.id).toBe("openai");
  });

  it("stream() lanza MissingCredentialsError: pendiente de validación real (no certificado por mocks)", () => {
    const provider = new OpenAIResponsesProvider({ apiKey: "sk-test" });
    expect(() => provider.stream(baseRequest)).toThrow(MissingCredentialsError);
  });
});
