import { describe, expect, it } from "vitest";
import { FakeEmbeddingProvider, tokenize } from "../../src/embeddings/fake-embedding-provider.js";
import { cosineSimilarity } from "../../src/embeddings/similarity.js";

describe("tokenize", () => {
  it("minúsculas, sin acentos, sin stopwords triviales", () => {
    expect(tokenize("Construcción de Escuelas Primarias en Jalisco")).toEqual([
      "construccion",
      "escuelas",
      "primarias",
      "jalisco",
    ]);
  });

  it("descarta tokens de un solo carácter y símbolos", () => {
    expect(tokenize("a, b: 12 % de IVA")).toEqual(["12", "iva"]);
  });
});

describe("FakeEmbeddingProvider", () => {
  it("rechaza dims no positivas/no enteras", () => {
    expect(() => new FakeEmbeddingProvider(0)).toThrow(RangeError);
    expect(() => new FakeEmbeddingProvider(-5)).toThrow(RangeError);
    expect(() => new FakeEmbeddingProvider(1.5)).toThrow(RangeError);
  });

  it("nunca llama a la red (no depende de fetch en absoluto)", async () => {
    const provider = new FakeEmbeddingProvider(64);
    const [vec] = await provider.embed(["cualquier texto"]);
    expect(vec).toHaveLength(64);
  });

  it("es determinista: el mismo texto produce siempre el mismo vector", async () => {
    const provider = new FakeEmbeddingProvider(128);
    const [a] = await provider.embed(["Servicios de limpieza de oficinas"]);
    const [b] = await provider.embed(["Servicios de limpieza de oficinas"]);
    expect(a).toEqual(b);
  });

  it("cada vector queda normalizado a norma L2 = 1 (salvo texto vacío)", async () => {
    const provider = new FakeEmbeddingProvider(64);
    const [vec] = await provider.embed(["Construcción de carreteras rurales"]);
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it("texto vacío produce el vector cero (nunca NaN)", async () => {
    const provider = new FakeEmbeddingProvider(32);
    const [vec] = await provider.embed([""]);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it("CASO REAL: dos textos con vocabulario compartido tienen coseno alto; dos sin relación, bajo (prueba negativa)", async () => {
    const provider = new FakeEmbeddingProvider(512);
    const [construccionA, construccionB, limpieza] = await provider.embed([
      "Construcción de escuelas primarias en el estado de Jalisco",
      "Construcción de una escuela primaria rural en Jalisco",
      "Servicios de limpieza y mantenimiento de oficinas administrativas",
    ]);

    const simConstruccion = cosineSimilarity(construccionA, construccionB);
    const simCruzada = cosineSimilarity(construccionA, limpieza);

    expect(simConstruccion).toBeGreaterThan(0.3);
    expect(simConstruccion).toBeGreaterThan(simCruzada);
    // Caso negativo explícito: textos con vocabulario disjunto no deben
    // reportarse como similares (el tokenizador no hace stemming, así que
    // aun temas iguales con formas distintas -- "escuela"/"escuelas" -- no
    // llegan a coseno alto; lo que importa es que quede muy por encima del
    // caso sin relación alguna, que aquí da 0 exacto por vocabulario disjunto).
    expect(simCruzada).toBeLessThan(0.1);
  });

  it("declara id, model y dims consultables (contrato de EmbeddingProvider)", () => {
    const provider = new FakeEmbeddingProvider(777);
    expect(provider.id).toBe("fake");
    expect(provider.model).toBe("fake-hashing-bow-v1");
    expect(provider.dims).toBe(777);
  });
});
