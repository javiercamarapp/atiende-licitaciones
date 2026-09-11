import { describe, expect, it, vi } from "vitest";
import { OpenAIEmbeddingProvider } from "../../src/embeddings/openai-embedding-provider.js";
import { MissingCredentialsError, NonRetryableProviderError, RetryableProviderError } from "../../src/errors.js";

function jsonResponse(status: number, body: unknown, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("OpenAIEmbeddingProvider", () => {
  it("lanza MissingCredentialsError si no hay OPENAI_API_KEY ni apiKey explícita, sin llegar a llamar fetch", async () => {
    const fetchImpl = vi.fn();
    const provider = new OpenAIEmbeddingProvider({ fetchImpl, apiKey: undefined });
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      await expect(provider.embed(["texto"])).rejects.toThrow(MissingCredentialsError);
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });

  it("con lista vacía de textos, nunca llama a la red (ni siquiera exige credenciales)", async () => {
    const fetchImpl = vi.fn();
    const provider = new OpenAIEmbeddingProvider({ fetchImpl, apiKey: undefined });
    await expect(provider.embed([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("construye la solicitud POST /embeddings con modelo, dims y headers correctos", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ index: 0, embedding: new Array(1536).fill(0.1) }] }),
    );
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test-123", fetchImpl });

    await provider.embed(["Construcción de escuelas"]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer sk-test-123");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.dimensions).toBe(1536);
    expect(body.input).toEqual(["Construcción de escuelas"]);
  });

  it("respeta el modelo/dims configurados", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ index: 0, embedding: new Array(256).fill(0.2) }] }),
    );
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test", fetchImpl, model: "text-embedding-3-large", dims: 256 });
    const [vec] = await provider.embed(["x"]);
    expect(vec).toHaveLength(256);
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.model).toBe("text-embedding-3-large");
  });

  it("reordena los vectores devueltos por `index` (la API puede no devolverlos en orden)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [
          { index: 1, embedding: [2, 2] },
          { index: 0, embedding: [1, 1] },
        ],
      }),
    );
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test", fetchImpl, dims: 2 });
    const vectors = await provider.embed(["primero", "segundo"]);
    expect(vectors).toEqual([[1, 1], [2, 2]]);
  });

  it("CASO NEGATIVO: lanza NonRetryableProviderError si falta el vector de algún índice", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ index: 0, embedding: [1, 2] }] }));
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test", fetchImpl, dims: 2 });
    await expect(provider.embed(["a", "b"])).rejects.toThrow(NonRetryableProviderError);
  });

  it("CASO NEGATIVO: lanza NonRetryableProviderError si la dimensión del vector no coincide con la declarada", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ index: 0, embedding: [1, 2, 3] }] }));
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test", fetchImpl, dims: 2 });
    await expect(provider.embed(["a"])).rejects.toThrow(NonRetryableProviderError);
  });

  it("lanza RetryableProviderError ante 429 y 500/503", async () => {
    const provider429 = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(429, { error: "rate limited" })),
    });
    await expect(provider429.embed(["x"])).rejects.toThrow(RetryableProviderError);

    const provider503 = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(503, { error: "unavailable" })),
    });
    await expect(provider503.embed(["x"])).rejects.toThrow(RetryableProviderError);
  });

  it("lanza NonRetryableProviderError ante 400/401", async () => {
    const provider400 = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(400, { error: "bad request" })),
    });
    await expect(provider400.embed(["x"])).rejects.toThrow(NonRetryableProviderError);

    const provider401 = new OpenAIEmbeddingProvider({
      apiKey: "sk-test",
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(401, { error: "unauthorized" })),
    });
    await expect(provider401.embed(["x"])).rejects.toThrow(NonRetryableProviderError);
  });

  it("declara id/model/dims por defecto (contrato de EmbeddingProvider)", () => {
    const provider = new OpenAIEmbeddingProvider({ apiKey: "sk-test" });
    expect(provider.id).toBe("openai");
    expect(provider.model).toBe("text-embedding-3-small");
    expect(provider.dims).toBe(1536);
  });
});
