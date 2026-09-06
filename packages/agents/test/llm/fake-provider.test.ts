import { describe, expect, it } from "vitest";
import { FakeProvider } from "../../src/llm/fake-provider.js";
import type { LLMCompletionRequest } from "../../src/llm/provider.js";

const baseRequest: LLMCompletionRequest = {
  model: "fake-model",
  tier: "economico",
  messages: [
    { role: "system", content: "Eres un asistente de licitaciones" },
    { role: "user", content: "Resume la convocatoria 123" },
  ],
};

describe("FakeProvider", () => {
  it("nunca llama a la red: no requiere fetch ni credenciales", async () => {
    const provider = new FakeProvider();
    const result = await provider.complete(baseRequest);
    expect(result.content).toContain("[fake:economico:");
    expect(result.toolCalls).toEqual([]);
  });

  it("es determinista: el mismo input produce siempre el mismo resultado", async () => {
    const provider = new FakeProvider();
    const r1 = await provider.complete(baseRequest);
    const r2 = await provider.complete(baseRequest);
    expect(r1).toEqual(r2);
  });

  it("produce resultados distintos ante mensajes distintos", async () => {
    const provider = new FakeProvider();
    const r1 = await provider.complete(baseRequest);
    const r2 = await provider.complete({ ...baseRequest, messages: [{ role: "user", content: "otro contenido" }] });
    expect(r1.content).not.toBe(r2.content);
  });

  it("acepta un script personalizado para pruebas dirigidas", async () => {
    const provider = new FakeProvider(() => ({
      content: "respuesta guionada",
      toolCalls: [{ id: "call-1", name: "get_tender", arguments: { id: "1" } }],
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    const result = await provider.complete(baseRequest);
    expect(result.content).toBe("respuesta guionada");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("declara countryOfResidence US y supportsToolCalls true", () => {
    const provider = new FakeProvider();
    expect(provider.countryOfResidence).toBe("US");
    expect(provider.supportsToolCalls).toBe(true);
    expect(provider.id).toBe("fake");
  });

  it("stream() emite un delta de contenido y un evento done con el mismo usage", async () => {
    const provider = new FakeProvider();
    const events = [];
    for await (const event of provider.stream(baseRequest)) {
      events.push(event);
    }
    expect(events[0].type).toBe("content_delta");
    expect(events[1].type).toBe("done");
  });
});
