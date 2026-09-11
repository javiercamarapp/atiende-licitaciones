import { describe, expect, it } from "vitest";
import { cosineSimilarity, l2normalize } from "../../src/embeddings/similarity.js";

describe("cosineSimilarity", () => {
  it("vectores idénticos -> 1", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("vectores ortogonales -> 0", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it("vectores opuestos -> -1", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 10);
  });

  it("cualquier vector cero -> 0, nunca NaN (caso negativo: división entre norma 0)", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("lanza RangeError si las dimensiones no coinciden", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(RangeError);
  });
});

describe("l2normalize", () => {
  it("produce norma 1 para un vector no nulo", () => {
    const normalized = l2normalize([3, 4]);
    expect(normalized).toEqual([0.6, 0.8]);
  });

  it("deja el vector cero sin cambios (nunca NaN)", () => {
    expect(l2normalize([0, 0, 0])).toEqual([0, 0, 0]);
  });
});
