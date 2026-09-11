import { describe, expect, it } from "vitest";
import {
  computeMarketResearchStats,
  computePriceBand,
  isWithinPriceBand,
  PRICE_BAND_LOWER_FACTOR,
  PRICE_BAND_UPPER_FACTOR,
} from "../../src/analytics/price-band.js";

describe("computePriceBand (REQ-030)", () => {
  it("aplica la fórmula legal [promedio×0.60, mediana×1.10] con half-up al centavo", () => {
    const band = computePriceBand({ averageMarketResearch: "100000.00", medianMarketResearch: "95000.00" });
    expect(band.min).toBe("60000.00");
    expect(band.max).toBe("104500.00");
    expect(band.degenerate).toBe(false);
  });

  it("los factores de la fórmula son literalmente 0.60 y 1.10", () => {
    expect(PRICE_BAND_LOWER_FACTOR).toBe(0.6);
    expect(PRICE_BAND_UPPER_FACTOR).toBe(1.1);
  });

  it("redondea half-up al centavo, no trunca ni redondea a la baja", () => {
    // 100.005 no es una cadena decimal válida (máx 2 decimales) -- se prueba
    // el half-up con un caso que sí produce residuo exacto de 0.5 centavo
    // en la multiplicación por 0.60: 33.335 -> pero como entrada solo
    // admite 2 decimales, se prueba con un promedio que al multiplicar por
    // 0.60 cae exactamente en .5 centavos internamente (100.01 * 0.60 = 60.006 -> 60.01 half-up).
    const band = computePriceBand({ averageMarketResearch: "100.01", medianMarketResearch: "100.01" });
    expect(band.min).toBe("60.01"); // 10001 * 0.60 = 6000.6 centavos -> half-up 6001 -> 60.01
    expect(band.max).toBe("110.01"); // 10001 * 1.10 = 11001.1 -> half-up 11001 -> 110.01
  });

  it("banda degenerada (min > max) se reporta explícitamente, nunca se intercambia en silencio", () => {
    // promedio muy superior a la mediana (distribución con outliers altos)
    const band = computePriceBand({ averageMarketResearch: "500000.00", medianMarketResearch: "10000.00" });
    expect(band.degenerate).toBe(true);
    expect(band.min).toBe("300000.00");
    expect(band.max).toBe("11000.00");
    // nunca se corrige a [11000, 300000] -- se deja tal cual para revisión humana
    expect(Number(band.min)).toBeGreaterThan(Number(band.max));
  });

  it("promedio y mediana iguales produce banda [avg×0.60, avg×1.10]", () => {
    const band = computePriceBand({ averageMarketResearch: "1000.00", medianMarketResearch: "1000.00" });
    expect(band.min).toBe("600.00");
    expect(band.max).toBe("1100.00");
    expect(band.degenerate).toBe(false);
  });

  it("cero es aritméticamente válido (banda [0,0]), pero negativos se rechazan", () => {
    const band = computePriceBand({ averageMarketResearch: "0.00", medianMarketResearch: "0.00" });
    expect(band.min).toBe("0.00");
    expect(band.max).toBe("0.00");

    expect(() => computePriceBand({ averageMarketResearch: "-100.00", medianMarketResearch: "100.00" })).toThrow(
      /no admite montos negativos/,
    );
    expect(() => computePriceBand({ averageMarketResearch: "100.00", medianMarketResearch: "-100.00" })).toThrow(
      /no admite montos negativos/,
    );
  });

  it("rechaza cadenas decimales malformadas (nunca las interpreta silenciosamente)", () => {
    expect(() => computePriceBand({ averageMarketResearch: "cien mil", medianMarketResearch: "100.00" })).toThrow(
      /Cadena decimal inválida/,
    );
    expect(() => computePriceBand({ averageMarketResearch: "100.999", medianMarketResearch: "100.00" })).toThrow(
      /Cadena decimal inválida/,
    );
  });

  it("montos grandes (millones de pesos, típico de un contrato gubernamental) no pierden precisión", () => {
    const band = computePriceBand({ averageMarketResearch: "123456789.99", medianMarketResearch: "98765432.10" });
    expect(band.min).toBe("74074073.99"); // 12345678999 * 0.60 = 7407407399.4 -> half-up 7407407399 -> /100
    expect(band.max).toBe("108641975.31");
  });
});

describe("isWithinPriceBand", () => {
  const band = computePriceBand({ averageMarketResearch: "100000.00", medianMarketResearch: "95000.00" }); // [60000.00, 104500.00]

  it("dentro de la banda (inclusive en ambos extremos)", () => {
    expect(isWithinPriceBand("60000.00", band)).toBe(true);
    expect(isWithinPriceBand("104500.00", band)).toBe(true);
    expect(isWithinPriceBand("80000.00", band)).toBe(true);
  });

  it("fuera de la banda por debajo o por encima", () => {
    expect(isWithinPriceBand("59999.99", band)).toBe(false);
    expect(isWithinPriceBand("104500.01", band)).toBe(false);
  });
});

describe("computeMarketResearchStats (auxiliar de observaciones reales)", () => {
  it("calcula promedio y mediana half-up sobre una lista impar de observaciones", () => {
    const stats = computeMarketResearchStats(["100.00", "200.00", "300.00"]);
    expect(stats.averageMarketResearch).toBe("200.00");
    expect(stats.medianMarketResearch).toBe("200.00");
  });

  it("calcula la mediana half-up cuando el conteo es par (promedio de los dos centrales)", () => {
    const stats = computeMarketResearchStats(["100.00", "200.00", "300.00", "401.00"]);
    // ordenado: 100, 200, 300, 401 -> mediana = (200+300)/2 = 250.00 exacto
    expect(stats.medianMarketResearch).toBe("250.00");
  });

  it("mediana par con residuo exacto de 0.5 centavo redondea half-up", () => {
    const stats = computeMarketResearchStats(["100.01", "100.02"]);
    // (10001 + 10002) / 2 = 10001.5 -> half-up 10002 -> 100.02
    expect(stats.medianMarketResearch).toBe("100.02");
  });

  it("promedio con residuo pequeño trunca hacia abajo (half-up solo sube cuando el residuo es >= la mitad)", () => {
    const stats = computeMarketResearchStats(["100.00", "100.00", "100.01"]);
    // suma = 30001 centavos / 3 -> cociente 10000, residuo 1; residuo*2=2 < 3 -> no sube -> 100.00
    expect(stats.averageMarketResearch).toBe("100.00");
  });

  it("promedio con residuo grande redondea half-up hacia arriba", () => {
    const stats = computeMarketResearchStats(["100.00", "100.00", "100.02"]);
    // suma = 30002 centavos / 3 -> cociente 10000, residuo 2; residuo*2=4 >= 3 -> sube -> 100.01
    expect(stats.averageMarketResearch).toBe("100.01");
  });

  it("promedio exacto, sin residuo", () => {
    const stats2 = computeMarketResearchStats(["100.00", "100.00", "100.03"]);
    // suma = 30003 / 3 = 10001 exacto
    expect(stats2.averageMarketResearch).toBe("100.01");
  });

  it("rechaza lista vacía (nunca fabrica un promedio de la nada)", () => {
    expect(() => computeMarketResearchStats([])).toThrow(/al menos una observación real/);
  });

  it("rechaza observaciones negativas", () => {
    expect(() => computeMarketResearchStats(["100.00", "-50.00"])).toThrow(/negativa no admitida/);
  });

  it("el resultado alimenta directamente computePriceBand", () => {
    const stats = computeMarketResearchStats(["90000.00", "100000.00", "110000.00"]);
    const band = computePriceBand(stats);
    expect(band.min).toBe("60000.00");
    expect(band.max).toBe("110000.00");
  });
});
