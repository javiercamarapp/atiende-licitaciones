import { describe, expect, it } from "vitest";
import { classifyNegativeListRisk, isNegativeListStale, NEGATIVE_LIST_STALE_THRESHOLD_MS } from "../src/types.js";

describe("classifyNegativeListRisk", () => {
  it.each([
    ["Definitivo", "definitivo"],
    ["DEFINITIVO", "definitivo"],
    ["Presunto", "presunto"],
    ["Desvirtuado", "desvirtuado"],
    ["Sentencia Favorable", "sentencia_favorable"],
    ["  sentencia   favorable  ".trim(), "desconocido"], // espacios internos de más no se normalizan -- documentado: coincidencia exacta tras trim/lower/sin-acentos
  ])("%s -> %s", (raw, expected) => {
    expect(classifyNegativeListRisk(raw)).toBe(expected);
  });

  it("una categoría nueva no contemplada por el SAT nunca se clasifica en silencio como una existente", () => {
    expect(classifyNegativeListRisk("Vinculado a Fraude Fiscal Nuevo")).toBe("desconocido");
  });
});

describe("isNegativeListStale", () => {
  const now = () => new Date("2026-09-10T12:00:00.000Z");

  it("nunca corrió (null) -> siempre obsoleta, nunca 'reciente' implícito", () => {
    expect(isNegativeListStale(null, now)).toBe(true);
  });

  it("corrida exitosa hace 1h -> no obsoleta", () => {
    const recent = new Date(now().getTime() - 60 * 60 * 1000);
    expect(isNegativeListStale(recent, now)).toBe(false);
  });

  it("corrida exitosa hace exactamente 48h -> aún no obsoleta (umbral estricto >)", () => {
    const exact = new Date(now().getTime() - NEGATIVE_LIST_STALE_THRESHOLD_MS);
    expect(isNegativeListStale(exact, now)).toBe(false);
  });

  it("corrida exitosa hace 49h -> obsoleta", () => {
    const stale = new Date(now().getTime() - 49 * 60 * 60 * 1000);
    expect(isNegativeListStale(stale, now)).toBe(true);
  });
});
